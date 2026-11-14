/** What the warmer reads of a host usage report. */
export interface WarmedReport {
  id: string;
  /** When the host's lookup began. */
  fetchedAt: string;
  /** When a lookup that answered with usage ended. */
  successfulAt?: string;
}

/** One host usage read: `refresh` makes the host ask the vendor, otherwise it answers its cache. */
export type HostRead = (
  refresh: boolean,
  signal: AbortSignal,
) => Promise<readonly WarmedReport[]>;

export interface WarmerClock {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/** Both host builds answer a report from their cache this long after its lookup ended. */
export const HOST_WINDOW = 300_000;
/** The warmer renews a report this old: a forced lookup then ends inside the window it replaces. */
export const RENEW_AT = HOST_WINDOW - 10_000;
/**
 * How old a report is when the warmer nudges to learn how the host renews it. The Windows build
 * renews behind a read in the last minute of the window, and its lookup begins once its discovery
 * answers, which takes seconds and at times more: nudged this early, a renewal behind it still begins
 * before the window ends, so a slow discovery is not taken for a host that renews nothing ahead.
 */
export const LEARN_AT = HOST_WINDOW - 40_000;
/**
 * A nudge covers every report this much younger than the oldest, as the Windows build renews them
 * behind it too: the last minute of their windows, though their sources answer seconds apart.
 */
const NUDGE_REACH = 30_000;
/** How long after a window ends the warmer looks whether someone else renewed it. */
export const LATE_CHECK = 10_000;
/**
 * A plain read this late in a report's window may make the Windows build renew it: the build renews
 * in the last minute at most, timed from a discovery that ends a moment before the lookup begins.
 */
const RENEWS_FROM = HOST_WINDOW - 65_000;
/** The warmer stops once Aster opened no session and read no usage for the user this long. */
export const IDLE_LIMIT = 2 * 3_600_000;
/** A failed read, or a host that renews nothing, is asked again this much later. */
export const RETRY_AFTER = 60_000;
/**
 * How long what the warmer learned of the host is trusted: that it renews behind a nudge, or that it
 * renews nothing ahead. A report looked up later is nudged early and looked at after its window
 * again, so a wrong lesson (a look the machine slept through) lasts an hour and a window at most.
 */
export const TRUSTED = 3_600_000;
/**
 * A step this much later than its timer was set for ran after the machine slept or the process
 * stalled, which may have held up the host's renewal too: a look then tells nothing of the host.
 */
export const STALL = 5_000;
/** How long after a trusted nudge the renewal behind it is taken to begin: its discovery's time. */
const NUDGE_SETTLE = 5_000;
/** How long after a read the lookup it made the host renew may begin: discovery, and its deadline. */
const RENEW_LAG = 25_000;
/** How soon a host that still answers a window it should have ended is asked again. */
const RECHECK = 2_000;
/** How long after a lookup began the host may still answer it: its 20-second deadline and more. */
const CHECK_LIMIT = HOST_WINDOW + 25_000;
/** No step follows another sooner than this. */
const MIN_DELAY = 1_000;
/** The longest delay `setTimeout` keeps: Node runs a longer one after a millisecond, and warns. */
const TIMEOUT_MAX = 2 ** 31 - 1;

export const realClock: WarmerClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => {
    // Cut short, the timer runs a step early, which finds nothing due and waits again.
    const timer = setTimeout(run, Math.min(ms, TIMEOUT_MAX));
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

interface Seen {
  /** When the lookup began. */
  at: number;
  /** When the host stops answering it from its cache, as far as the report tells. */
  until: number;
}

/** A look at the host after a window ends: who renewed the reports it held, and when. */
interface Check {
  before: Map<string, Seen>;
  at: number;
  /** The warmer nudged the host before the window ended. */
  nudged: boolean;
}

/**
 * Keeps the host's usage cache current while Aster is in use, so a Claude session open finds its
 * reports there instead of waiting about a second for the vendor.
 *
 * Both host builds answer a report from their cache for five minutes after its lookup ended. The
 * Windows build renews a report that a plain read finds in the last minute of that window behind the
 * read's answer, which is how the app polling the usage screen keeps it current; the Linux build
 * renews nothing ahead, and the first read after the window waits for the vendor.
 *
 * The warmer first only looks, ten seconds after a window ends, whether someone renewed its reports
 * before it ended. While someone does, it asks the vendor for nothing. Once nobody does, it nudges:
 * a plain read forty seconds before the window ends, which the Windows build renews behind and the
 * Linux build answers from its cache. When the read after that window is what fetched the reports
 * again, the host renews nothing ahead, and the warmer forces the lookup ten seconds before the
 * window ends; when the host renewed behind the nudge, a plain read then is enough. Either lesson
 * holds for an hour, and a look the machine may have slept through teaches nothing. The reports it
 * reads only time its steps: Aster's sessions read theirs as before, under the same age limit.
 */
export class UsageWarmer {
  private lastActive = -Infinity;
  /** When Aster or the warmer read usage lately: on Windows such a read may have renewed a window. */
  private ownReads: number[] = [];
  /** The reports the host holds, by id, as last seen. */
  private seen = new Map<string, Seen>();
  /** Reports a trusted nudge left to the host: as they were then, and when it began renewing them. */
  private deferred = new Map<string, { at: number; renewedAt: number }>();
  private timer: unknown;
  private timerAt = Infinity;
  private running = false;
  private disposed = false;
  private readonly lifetime = new AbortController();
  /** Someone else renews the reports before their window ends, as an app polling the host does. */
  private others = true;
  /** The host was last seen renewing nothing ahead: the warmer forces the lookup inside the window. */
  private forcing = false;
  /** When the host was last seen renewing nothing ahead. */
  private forcingAt = -Infinity;
  /** When the host was last seen renewing behind a nudge. */
  private aheadAt = -Infinity;
  private check: Check | null = null;
  private failing = false;

  constructor(
    private readonly read: HostRead,
    private readonly clock: WarmerClock = realClock,
    private readonly log: (message: string) => void = (message) =>
      console.info(message),
  ) {}

  /** Aster opened a session or read usage for the user, and got these reports. */
  noteActivity(reports: readonly WarmedReport[]) {
    if (this.disposed) return;
    if (!this.active())
      this.log(
        "[aster] 사용량 배경 갱신 시작 (세션 열기·사용량 조회가 2시간 없으면 멈춤)",
      );
    this.lastActive = this.clock.now();
    this.observe(reports);
  }

  /** Reports Aster read in the background: they move the warmer's steps, not its idle limit. */
  observe(reports: readonly WarmedReport[]) {
    if (this.disposed) return;
    this.forgetAhead();
    this.noteOwnRead();
    for (const [id, seen] of windows(reports, this.clock.now())) {
      const known = this.seen.get(id);
      if (!known || known.at < seen.at) this.seen.set(id, seen);
    }
    if (this.running || !this.active()) return;
    this.arm();
    this.schedule(this.nextStep());
  }

  dispose() {
    this.disposed = true;
    this.lifetime.abort();
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.check = null;
  }

  private active() {
    return this.clock.now() - this.lastActive < IDLE_LIMIT;
  }

  /**
   * Forgets the times a clock set back since left ahead of now. A step timed from a report looked
   * up there would wait for the clock to catch up or, past what a timer holds, run at once and
   * again, and a look comparing with one would read every two seconds until then; reports looked
   * up ahead are not taken either (`windows`), so the warmer waits for one looked up since. A use
   * there counts as made now, so the warmer stops two hours later at most; a lesson there may be
   * of any age, so it is learned again.
   */
  private forgetAhead() {
    const now = this.clock.now();
    for (const [id, seen] of this.seen) if (seen.at > now) this.seen.delete(id);
    if (
      this.check &&
      [...this.check.before.values()].some((seen) => seen.at > now)
    )
      this.check = null;
    this.lastActive = Math.min(this.lastActive, now);
    if (this.forcingAt > now) this.forcingAt = -Infinity;
    if (this.aheadAt > now) this.aheadAt = -Infinity;
  }

  /** While someone else renews the reports, the next step only looks after the window ends. */
  private arm() {
    if (!this.others || this.check || !this.seen.size) return;
    this.check = {
      before: new Map(this.seen),
      at: this.quietAfter(
        Math.min(...[...this.seen.values()].map((seen) => seen.until)) +
          LATE_CHECK,
      ),
      nudged: false,
    };
  }

  /**
   * The first moment from `at` when a look renews nothing early: past every window it would reach
   * into the last minute of, which the reports of another source, renewed apart, may be in.
   */
  private quietAfter(at: number) {
    for (let moved = true; moved; ) {
      moved = false;
      for (const seen of this.seen.values())
        if (at >= seen.at + RENEWS_FROM && at < seen.until + LATE_CHECK) {
          at = seen.until + LATE_CHECK;
          moved = true;
        }
    }
    return at;
  }

  /**
   * A pending look, else the nudge when the oldest report reaches its nudge age. Every report is
   * timed by what is trusted of the oldest, as the nudge decides what is due by it: timed by its
   * own, a report looked up past the hour would wake the nudge every second until the oldest is due.
   */
  private nextStep() {
    if (this.check) return this.check.at;
    const age = this.trust(this.oldest()) ? RENEW_AT : LEARN_AT;
    return Math.min(
      ...[...this.seen].map(([id, seen]) => this.from(id, seen) + age),
    );
  }

  /** When a report's lookup began, or for one a trusted nudge left to the host, its renewal. */
  private from(id: string, seen: Seen) {
    const deferred = this.deferred.get(id);
    return deferred?.at === seen.at ? deferred.renewedAt : seen.at;
  }

  /** The earliest `from` of the reports the warmer knows. */
  private oldest() {
    return Math.min(...[...this.seen].map(([id, seen]) => this.from(id, seen)));
  }

  /**
   * What the warmer trusts of the host for a report whose lookup began at `from`: the last lesson,
   * unless it is `TRUSTED` older than the report, which is then nudged early to learn again.
   */
  private trust(from: number) {
    if (this.forcing) return from - this.forcingAt < TRUSTED ? "forcing" : null;
    return from - this.aheadAt < TRUSTED ? "ahead" : null;
  }

  private noteOwnRead() {
    const now = this.clock.now();
    this.ownReads = this.ownReads.filter((at) => now - at < 2 * HOST_WINDOW);
    this.ownReads.push(now);
  }

  /** Whether a read of Aster's own may have made the host begin a lookup at `at`. */
  private ownRenewal(at: number) {
    return this.ownReads.some((read) => Math.abs(at - read) <= RENEW_LAG);
  }

  /** Sets the one timer for `at`, moving an existing one only earlier. */
  private schedule(at: number) {
    if (this.disposed || !Number.isFinite(at)) return;
    at = Math.max(at, this.clock.now() + MIN_DELAY);
    if (this.timer !== undefined) {
      if (at >= this.timerAt) return;
      this.clock.clearTimer(this.timer);
    }
    this.timerAt = at;
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      void this.step(this.clock.now() - at > STALL);
    }, at - this.clock.now());
  }

  /** `stalled`: the timer fired well after its time, as after the machine slept. */
  private async step(stalled = false) {
    if (this.running || this.disposed) return;
    this.forgetAhead();
    if (!this.active()) {
      this.check = null;
      this.log(
        "[aster] 사용량 배경 갱신 멈춤: 2시간 동안 세션 열기·사용량 조회 없음",
      );
      return;
    }
    this.running = true;
    let next: number | undefined;
    try {
      next = this.check
        ? await this.verify(this.check, stalled)
        : await this.nudge();
      if (this.failing) this.log("[aster] 사용량 배경 갱신 복구");
      this.failing = false;
    } catch (error) {
      if (this.disposed) return;
      next = this.clock.now() + RETRY_AFTER;
      if (!this.failing)
        console.warn(
          `[aster] 사용량 배경 갱신 실패, ${RETRY_AFTER / 1000}초 뒤 다시: ${String(error).slice(0, 200)}`,
        );
      this.failing = true;
    } finally {
      this.running = false;
      if (!this.disposed) {
        this.arm();
        this.schedule(next ?? this.nextStep());
      }
    }
  }

  /** Reads the host's reports, which replace what the warmer knew. */
  private async lookup(refresh: boolean) {
    if (!refresh) this.noteOwnRead();
    const reports = await this.read(refresh, this.lifetime.signal);
    this.lifetime.signal.throwIfAborted();
    this.seen = windows(reports, this.clock.now());
    for (const [id, deferred] of this.deferred)
      if (this.seen.get(id)?.at !== deferred.at) this.deferred.delete(id);
  }

  /**
   * The plain read before the oldest report's window ends. What is due then is forced on a host
   * seen within the hour renewing nothing ahead, taken as renewed on a host seen within the hour
   * renewing behind a nudge, and otherwise nudged early and left to the look after its window.
   */
  private async nudge() {
    const before = this.seen;
    await this.lookup(false);
    const now = this.clock.now();
    const age = ([, seen]: [string, Seen]) =>
      seen.at <= now ? now - seen.at : -Infinity;
    const trust = this.trust(this.oldest());
    const nudgeAge = trust ? RENEW_AT : LEARN_AT;
    // Due once the oldest is, and then with every report the nudge also reaches.
    const due = [...this.seen].some(
      (entry) => age(entry) >= nudgeAge - MIN_DELAY,
    )
      ? [...this.seen].filter((entry) => age(entry) >= nudgeAge - NUDGE_REACH)
      : [];
    if (!due.length) {
      // Renewed before the warmer asked, and not behind a read of Aster's own (a nudge or a
      // session's), which the Windows build renews behind alike.
      if (
        [...this.seen].some(([id, seen]) => {
          const was = before.get(id);
          return was && seen.at > was.at && !this.ownRenewal(seen.at);
        })
      )
        this.setOthers(true);
      return undefined;
    }
    if (trust === "forcing") {
      await this.lookup(true);
      return undefined;
    }
    // A host seen renewing behind a nudge lately needs no look after the window to tell: what was
    // due is taken as renewed, so the next nudge comes a window later instead of reading again
    // while the renewal runs. Should the host not renew it, that nudge finds the window over.
    if (trust === "ahead") {
      for (const [id, seen] of due)
        this.deferred.set(id, { at: seen.at, renewedAt: now + NUDGE_SETTLE });
      return undefined;
    }
    this.check = {
      before: new Map(due),
      at: Math.max(...due.map(([, seen]) => seen.until)) + 250,
      nudged: true,
    };
    return undefined;
  }

  /**
   * After a window: a report fetched again before it ended was renewed ahead, by the host behind
   * a nudge or by someone else; one fetched again after it was waited for, at least by this read.
   * A look after a stall only reads the reports anew: the host may have slept through the window.
   */
  private async verify(check: Check, stalled: boolean) {
    await this.lookup(false);
    if (stalled) {
      this.check = null;
      return undefined;
    }
    let ahead = false;
    let late = false;
    let waiting = false;
    for (const [id, before] of check.before) {
      const seen = this.seen.get(id);
      if (!seen) continue;
      if (seen.at <= before.at) waiting = true;
      else if (seen.at < before.until) ahead = true;
      else late = true;
    }
    if (waiting && !ahead && !late) {
      const limit =
        Math.min(...[...check.before.values()].map((seen) => seen.at)) +
        CHECK_LIMIT;
      // The host still answers a window the report says has ended: its lookup ended later.
      if (this.clock.now() < limit) {
        check.at = check.nudged
          ? this.clock.now() + RECHECK
          : this.quietAfter(this.clock.now() + RECHECK);
        return undefined;
      }
      this.check = null;
      return this.clock.now() + RETRY_AFTER;
    }
    this.check = null;
    if (late && !ahead) {
      if (check.nudged) this.learned(true);
      else this.setOthers(false);
    } else if (ahead && !late && check.nudged) this.learned(false);
    return undefined;
  }

  private setOthers(others: boolean) {
    if (this.others === others) return;
    this.others = others;
    this.log(
      others
        ? "[aster] 사용량 배경 갱신: 다른 조회(앱 등)가 창이 끝나기 전에 갱신해 공급사 조회를 더하지 않음"
        : "[aster] 사용량 배경 갱신: 창이 끝나기 전에 갱신하는 다른 조회가 없어 창이 끝나기 10초 전에 갱신",
    );
  }

  /** What a look after a nudged window showed: the host renews nothing ahead, or renews behind it. */
  private learned(forcing: boolean) {
    const now = this.clock.now();
    this.forcingAt = forcing ? now : -Infinity;
    this.aheadAt = forcing ? -Infinity : now;
    if (this.forcing === forcing) return;
    this.forcing = forcing;
    this.log(
      forcing
        ? "[aster] 사용량 배경 갱신: 호스트가 창이 끝나기 전에 스스로 갱신하지 않아 창이 끝나기 10초 전에 강제 갱신"
        : "[aster] 사용량 배경 갱신: 호스트가 창이 끝나기 전에 스스로 갱신해 강제 갱신을 멈춤",
    );
  }
}

/**
 * Each report's lookup and the window the host answers it for, by id. A report looked up ahead of
 * `now`, by a clock set back since, tells nothing of when its window ends: the host's cache, timed
 * by that clock, holds it until the clock catches up.
 */
function windows(reports: readonly WarmedReport[], now: number) {
  const seen = new Map<string, Seen>();
  for (const report of reports) {
    const at = Date.parse(report.fetchedAt);
    if (!Number.isFinite(at) || at > now) continue;
    const ended = Date.parse(report.successfulAt ?? "");
    const until =
      (Number.isFinite(ended) && ended >= at ? ended : at) + HOST_WINDOW;
    const known = seen.get(report.id);
    if (!known || known.at < at) seen.set(report.id, { at, until });
  }
  return seen;
}
