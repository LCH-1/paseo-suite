import assert from "node:assert/strict";
import test from "node:test";
import { UsageReader } from "./accounts.ts";
import {
  HOST_WINDOW,
  IDLE_LIMIT,
  LATE_CHECK,
  RENEW_AT,
  RETRY_AFTER,
  TRUSTED,
  UsageWarmer,
  realClock,
  type HostRead,
  type WarmedReport,
  type WarmerClock,
} from "./usage-warmer.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The longest delay Node's `setTimeout` keeps: it runs a longer one after a millisecond. */
const TIMEOUT_MAX = 2 ** 31 - 1;
const DAY = 86_400_000;

/** Fake time: `run` fires timers in order, settling what each one started before the next. */
class Time {
  now = Date.parse("2026-11-14T00:00:00Z");
  /** The longest delay a timer was asked for. */
  longest = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  readonly clock: WarmerClock = {
    now: () => this.now,
    setTimer: (run, ms) => {
      const id = ++this.seq;
      this.longest = Math.max(this.longest, ms);
      // As Node runs a delay it cannot keep.
      const delay = ms > TIMEOUT_MAX ? 1 : Math.max(0, ms);
      this.timers.set(id, { at: this.now + delay, run });
      return id;
    },
    clearTimer: (id) => void this.timers.delete(id as number),
  };
  sleep(ms: number) {
    return new Promise<void>((resolve) => this.clock.setTimer(resolve, ms));
  }
  get pending() {
    return this.timers.size;
  }
  /** The machine sleeps: the clock moves on, and the timers due meanwhile fire late, on waking. */
  suspend(ms: number) {
    this.now += ms;
  }
  /** The clock is set back (NTP): timers keep their delays, as Node's run on a steady clock. */
  setBack(ms: number) {
    this.now -= ms;
    for (const timer of this.timers.values()) timer.at -= ms;
  }
  async run(ms: number) {
    assert.ok(ms >= 0, "time only moves forward");
    const end = this.now + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers)
        if (!next || entry[1].at < next[1].at) next = entry;
      if (!next || next[1].at > Math.max(end, this.now)) break;
      this.timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].run();
    }
    this.now = Math.max(this.now, end);
    await settle();
  }
  /** Starts `task` now and tells how long it took in fake time. */
  async timed<T>(task: () => Promise<T>) {
    const started = this.now;
    let done = false;
    let value: T | undefined;
    void task().then((result) => {
      done = true;
      value = result;
    });
    await settle();
    while (!done) await this.run(10);
    return { value: value as T, ms: this.now - started };
  }
}

const FETCH = 1_300;
const DISCOVERY = 2_500;
/** A lookup, and whether it failed: a failed one's report does not tell when it ended. */
interface Lookup {
  fetchedAt: number;
  endedAt: number;
  failed?: boolean;
}
const report = (id: string, lookup: Lookup) => ({
  id,
  fetchedAt: new Date(lookup.fetchedAt).toISOString(),
  ...(lookup.failed
    ? {}
    : { successfulAt: new Date(lookup.endedAt).toISOString() }),
});

/** A host that counts what reaches the vendor and which reads the warmer made. */
abstract class Host {
  vendor = 0;
  reads: boolean[] = [];
  /** When the warmer last read. */
  lastRead = -Infinity;
  readonly ids = ["claude:fixture", "codex:fixture"];
  protected readonly cache = new Map<string, Lookup>();
  /** Accounts whose lookups fail this long after they begin, as a vendor that times out. */
  readonly failing = new Map<string, number>();
  /** When each account's lookups began. */
  readonly lookups = new Map<string, number[]>();
  constructor(protected readonly time: Time) {}
  /** Who made each read that started a renewal (Windows build only). */
  renewedBy: string[] = [];
  /** Told of each read the warmer makes, as it makes it. */
  onRead?: (refresh: boolean) => void;
  abstract list(refresh: boolean, by?: string): Promise<WarmedReport[]>;
  /** What the warmer is given: the same reads, recorded. */
  readonly warmerRead: HostRead = (refresh) => {
    this.reads.push(refresh);
    this.lastRead = this.time.now;
    this.onRead?.(refresh);
    return this.list(refresh, "warmer");
  };
  /** When the window of the reports cached last ends. */
  windowEnd() {
    return (
      Math.max(...[...this.cache.values()].map((lookup) => lookup.endedAt)) +
      HOST_WINDOW
    );
  }
  protected async lookup(id: string) {
    const fetchedAt = this.time.now;
    this.vendor++;
    this.lookups.set(id, [...(this.lookups.get(id) ?? []), fetchedAt]);
    const failing = this.failing.get(id);
    await this.time.sleep(failing ?? FETCH);
    // Both builds time the window from when the lookup ended, failed or not.
    const lookup = {
      fetchedAt,
      endedAt: this.time.now,
      failed: failing !== undefined,
    };
    this.cache.set(id, lookup);
    return report(id, lookup);
  }
}

/**
 * The Linux build (usage-sources as kept on the Linux hosts): each report is answered from its
 * cache for five minutes after its lookup ended and the first read after that waits for the vendor.
 * A forced read joins a lookup under way.
 */
class LinuxHost extends Host {
  private readonly running = new Map<string, Promise<WarmedReport>>();
  list(refresh: boolean) {
    return Promise.all(
      this.ids.map((id) => {
        const cached = this.cache.get(id);
        if (!refresh && cached && this.time.now - cached.endedAt < HOST_WINDOW)
          return report(id, cached);
        const running = this.running.get(id);
        if (running) return running;
        const task = this.lookup(id).finally(() => this.running.delete(id));
        this.running.set(id, task);
        return task;
      }),
    );
  }
}

/**
 * The Windows build (the fork's usage-sources): discovery and the reports share one window, a plain
 * read in its last minute renews them behind the answer, a read after it waits for the discovery and
 * then for each report past its window (one still in it answers from the cache while its lookup
 * runs), and a forced read renews again after any renewal under way.
 */
class WindowsHost extends Host {
  /** Sources that share a discovery, each renewed apart, and how long its discovery takes. */
  protected readonly groups: {
    ids: string[];
    discovery: number;
    discoveredAt: number;
    renewal: Promise<void> | null;
    /** The discovery of the renewal under way. */
    discovering?: Promise<void>;
  }[] = [
    {
      ids: this.ids,
      discovery: DISCOVERY,
      discoveredAt: -Infinity,
      renewal: null,
    },
  ];
  /** Each report's lookup under way. */
  private readonly running = new Map<string, Promise<unknown>>();
  async list(refresh: boolean, by = "other") {
    await Promise.all(
      this.groups.map(async (group) => {
        if (refresh)
          return await (group.renewal
            ? group.renewal.then(() => this.renew(group, by))
            : this.renew(group, by));
        const state = this.state(group);
        if (!group.renewal && state === "due") void this.renew(group, by);
        else if (state === "expired") {
          if (!group.renewal) void this.renew(group, by);
          await group.discovering;
        }
      }),
    );
    return Promise.all(
      this.ids.map(async (id) => {
        const cached = this.cache.get(id);
        if (!cached || this.time.now - cached.endedAt >= HOST_WINDOW)
          await this.running.get(id);
        return report(id, this.cache.get(id)!);
      }),
    );
  }
  private state(group: WindowsHost["groups"][number]) {
    const ages = [
      this.time.now - group.discoveredAt,
      ...group.ids.map((id) => {
        const cached = this.cache.get(id);
        return cached ? this.time.now - cached.endedAt : Infinity;
      }),
    ];
    if (ages.some((age) => age >= HOST_WINDOW)) return "expired";
    return ages.some((age) => age >= HOST_WINDOW - 60_000) ? "due" : "fresh";
  }
  protected renew(group: WindowsHost["groups"][number], by = "other") {
    this.renewedBy.push(by);
    const discovering = this.time.sleep(group.discovery).then(() => {
      group.discoveredAt = this.time.now;
      for (const id of group.ids) {
        const lookup: Promise<unknown> = this.lookup(id).finally(() => {
          if (this.running.get(id) === lookup) this.running.delete(id);
        });
        this.running.set(id, lookup);
      }
    });
    const running: Promise<void> = discovering
      .then(() => Promise.all(group.ids.map((id) => this.running.get(id))))
      .then(() => undefined)
      .finally(() => {
        if (group.renewal === running) group.renewal = null;
      });
    group.renewal = running;
    group.discovering = discovering;
    return running;
  }
}

/**
 * The Windows build with Claude and Codex discovered apart, as on the company PC: Claude's discovery
 * (PowerShell) takes seconds, Codex's a moment, and each source's window runs on its own.
 */
class SplitWindowsHost extends WindowsHost {
  protected readonly groups = [
    {
      ids: [this.ids[0]],
      discovery: DISCOVERY,
      discoveredAt: -Infinity,
      renewal: null,
    },
    {
      ids: [this.ids[1]],
      discovery: 50,
      discoveredAt: -Infinity,
      renewal: null,
    },
  ];
  /** Renews one source alone, as a refresh of that source would, to set the windows apart. */
  renewOnly(index: number) {
    return this.renew(this.groups[index]);
  }
}

/**
 * The Windows build with a discovery of twelve seconds each time: a renewal behind a read ten
 * seconds before the window ends begins its lookup after the window.
 */
class SlowWindowsHost extends WindowsHost {
  protected readonly groups = [
    {
      ids: this.ids,
      discovery: 12_000,
      discoveredAt: -Infinity,
      renewal: null,
    },
  ];
}

function setup(HostType: new (time: Time) => Host, warm = true) {
  const time = new Time();
  const host = new HostType(time);
  const logs: string[] = [];
  const warmer = new UsageWarmer(host.warmerRead, time.clock, (line) =>
    logs.push(line),
  );
  /** A session open's usage read, as `readUsage` makes it: timed, then shown to the warmer. */
  const open = async () => {
    const { value, ms } = await time.timed(() => host.list(false));
    if (warm) warmer.noteActivity(value);
    return ms;
  };
  return { time, host, warmer, logs, open };
}

const minute = 60_000;

/** How long a read takes at every `step` for `span`: a session open at any moment. */
async function probe(time: Time, host: Host, span: number, step = 10_000) {
  const waits: number[] = [];
  for (let at = 0; at < span; at += step) {
    const { ms } = await time.timed(() => host.list(false));
    waits.push(ms);
    await time.run(step - ms);
  }
  return waits;
}

test("앱 폴링이 없는 Linux 형 호스트에서 7분씩 쉬다 여는 세션은 배경 갱신이 없으면 매번 조회를 기다리고, 있으면 두 창 만에 배워 그 뒤로는 기다리지 않음", async () => {
  for (const warm of [false, true]) {
    const { time, host, warmer, logs, open } = setup(LinuxHost, warm);
    const waits: number[] = [];
    for (let index = 0; index < 9; index++) {
      waits.push(await open());
      await time.run(7 * minute);
    }
    // From the third window on, a session opening at any moment finds the cache current.
    const anyMoment = await probe(time, host, 30 * minute);
    warmer.dispose();
    // Without it the first read after every window waits, however often sessions open.
    const waited = anyMoment.filter((ms) => ms > 0).length;
    assert.ok(warm ? waited === 0 : waited >= 5, String(waited));
    if (!warm) {
      assert.deepEqual(new Set(waits), new Set([FETCH]));
      assert.equal(host.reads.length, 0);
      continue;
    }
    // The first open finds nothing cached; the warmer's own reads already renew what it watches.
    assert.equal(waits[0], FETCH);
    assert.deepEqual(waits.slice(1), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.ok(
      logs.some((line) => /창이 끝나기 10초 전에 강제 갱신/.test(line)),
    );
    // A forced lookup is always preceded by a plain read that found the reports due.
    for (const [index, refresh] of host.reads.entries())
      if (refresh) assert.equal(host.reads[index - 1], false);
    // Each account reaches the vendor once per window at most: 93 minutes, a window under five.
    const perAccount = host.vendor / host.ids.length;
    assert.ok(
      perAccount <= Math.ceil((93 * minute) / RENEW_AT) + 1,
      String(perAccount),
    );
  }
});

test("앱 폴링이 없는 Windows 형 호스트는 창이 끝나기 전 평범한 조회로 미리 갱신되어 강제 조회 없이 세션 열기가 기다리지 않고 창마다 공급사 호출은 한 번", async () => {
  const { time, host, warmer, logs, open } = setup(WindowsHost);
  const waits: number[] = [];
  for (let index = 0; index < 9; index++) {
    waits.push(await open());
    await time.run(7 * minute);
  }
  const anyMoment = await probe(time, host, 30 * minute);
  warmer.dispose();
  assert.deepEqual(host.reads.filter(Boolean), []);
  assert.equal(waits[0], DISCOVERY + FETCH);
  assert.deepEqual(waits.slice(1), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(new Set(anyMoment), new Set([0]));
  assert.ok(!logs.some((line) => /강제 갱신/.test(line)));
  const perAccount = host.vendor / host.ids.length;
  assert.ok(
    perAccount <= Math.ceil((93 * minute) / RENEW_AT) + 1,
    String(perAccount),
  );
});

test("앱이 60초마다 폴링해 이미 신선한 Windows 형 호스트에는 배경 갱신이 공급사 호출을 하나도 더하지 않음", async () => {
  const runs = [];
  for (const warm of [false, true]) {
    const { time, host, warmer, logs, open } = setup(WindowsHost, warm);
    let polling = true;
    const poll = () => {
      if (!polling) return;
      void host.list(false);
      time.clock.setTimer(poll, minute);
    };
    poll();
    const waits: number[] = [];
    for (let index = 0; index < 30; index++) {
      waits.push(await open());
      await time.run(7 * minute);
    }
    polling = false;
    warmer.dispose();
    runs.push({ vendor: host.vendor, reads: host.reads, waits, logs });
  }
  const [without, warmed] = runs;
  assert.equal(warmed.vendor, without.vendor);
  assert.deepEqual(warmed.waits, without.waits);
  assert.deepEqual(warmed.reads.filter(Boolean), []);
  // It only looked, about once a window.
  assert.ok(warmed.reads.length <= (30 * 7 * minute) / HOST_WINDOW + 2);
  assert.ok(!warmed.logs.some((line) => /10초 전에/.test(line)));
});

test("앱 폴링이 멈추면 다음 창부터 배경 갱신이 맡고 다시 폴링하면 공급사 조회를 앱에 돌려주며, Linux 형 호스트를 다른 쪽이 한 번 강제 갱신해도 한 창 뒤 강제 갱신으로 돌아감", async () => {
  const windows = setup(WindowsHost);
  let polling = true;
  const poll = () => {
    if (!polling) return;
    void windows.host.list(false);
    windows.time.clock.setTimer(poll, minute);
  };
  poll();
  await windows.open();
  await windows.time.run(30 * minute);
  // While the app polls the warmer only looks, about once a window.
  assert.ok(windows.host.reads.length <= 7, String(windows.host.reads.length));
  polling = false;
  await windows.time.run(15 * minute);
  // One window unwatched, then the warmer nudges and the rest are renewed ahead.
  assert.deepEqual(
    new Set(await probe(windows.time, windows.host, 30 * minute)),
    new Set([0]),
  );
  polling = true;
  poll();
  await windows.time.run(15 * minute);
  const vendor = windows.host.vendor;
  const reads = windows.host.reads.length;
  await windows.time.run(30 * minute);
  // Polled again, the host renews each window once, and the warmer only looks.
  assert.equal(windows.host.vendor - vendor, 6 * windows.host.ids.length);
  assert.ok(windows.host.reads.length - reads <= 6);
  assert.deepEqual(windows.host.reads.filter(Boolean), []);
  assert.deepEqual(
    windows.logs
      .filter((line) => /다른 조회/.test(line))
      .map((line) => /더하지 않음/.test(line)),
    [false, true],
  );
  windows.warmer.dispose();
  polling = false;

  const linux = setup(LinuxHost);
  await linux.open();
  await linux.time.run(20 * minute);
  assert.ok(linux.host.reads.some(Boolean));
  // Someone else forces a lookup inside the window (the app's refresh button), well apart from
  // the warmer's own reads.
  const last = linux.host.lastRead;
  while (linux.host.lastRead === last) await linux.time.run(1_000);
  await linux.time.run(2 * minute);
  await linux.time.timed(() => linux.host.list(true));
  await linux.time.run(15 * minute);
  assert.deepEqual(
    new Set(await probe(linux.time, linux.host, 30 * minute)),
    new Set([0]),
  );
  assert.deepEqual(
    linux.logs
      .filter((line) => /다른 조회/.test(line))
      .map((line) => /더하지 않음/.test(line)),
    [false, true, false],
  );
  linux.warmer.dispose();
});

test("앱이 60초마다 폴링하고 Claude·Codex 출처의 창이 1분 어긋난 Windows 형 호스트에서도, 한 출처의 창 뒤를 보는 조회가 다른 출처의 마지막 1분에 들어가 미리 갱신시키지 않아 공급사 호출이 같음", async () => {
  const runs = [];
  for (const warm of [false, true]) {
    const { time, host, warmer, open } = setup(SplitWindowsHost, warm);
    let polling = true;
    const poll = () => {
      if (!polling) return;
      void host.list(false);
      time.clock.setTimer(poll, minute);
    };
    // The app fetches both sources, then Codex alone a minute later; Aster opens after that.
    poll();
    await time.run(minute);
    await time.timed(() => (host as SplitWindowsHost).renewOnly(1));
    await time.run(10_000);
    await open();
    for (let index = 0; index < 30; index++) {
      await time.run(7 * minute);
      await open();
    }
    polling = false;
    warmer.dispose();
    runs.push({
      vendor: host.vendor,
      forced: host.reads.filter(Boolean),
      byWarmer: host.renewedBy.filter((by) => by === "warmer").length,
    });
  }
  assert.equal(runs[1].vendor, runs[0].vendor);
  assert.deepEqual(runs[1].forced, []);
  // None of its reads made the host renew anything: the app's polls did all of it.
  assert.equal(runs[1].byWarmer, 0);
});

test("앱 폴링이 없는 Windows 형 호스트에서 Aster 세션 열기가 창의 마지막 1분에 갱신시킨 것은 다른 조회의 갱신으로 보지 않아 계속 맡음", async () => {
  const { time, host, warmer, logs, open } = setup(SplitWindowsHost);
  for (let index = 0; index < 40; index++) {
    await open();
    await time.run(100_000);
  }
  assert.ok(!logs.some((line) => /다른 조회\(앱 등\)/.test(line)));
  assert.deepEqual(new Set(await probe(time, host, 30 * minute)), new Set([0]));
  assert.deepEqual(host.reads.filter(Boolean), []);
  // About one read a window: one nudge reaches both sources, though they answer seconds apart.
  const elapsed = 40 * 100_000 + 30 * minute;
  assert.ok(
    host.reads.length <= Math.ceil(elapsed / RENEW_AT) + 3,
    String(host.reads.length),
  );
  warmer.dispose();
});

/**
 * Has the machine sleep from two seconds after the warmer's first nudge, once it knows nobody else
 * renews ahead, until `wake` tells.
 */
function sleepAfterFirstNudge(
  { time, host, logs }: ReturnType<typeof setup>,
  wake: (nudgedAt: number) => number,
) {
  let slept = false;
  host.onRead = (refresh) => {
    if (slept || refresh || !logs.some((line) => /다른 조회가 없어/.test(line)))
      return;
    slept = true;
    const until = wake(time.now);
    time.clock.setTimer(() => time.suspend(until - time.now), 2_000);
  };
  return () => slept;
}

test("Windows 형 호스트에서 배우려고 보낸 조회 2초 뒤 기계가 30분 잠들어 창 뒤 확인이 늦게 돌면 그 확인으로는 배우지 않아, 강제 조회 없이 창마다 공급사 호출이 한 번", async () => {
  const run = setup(WindowsHost);
  const { time, host, warmer, logs, open } = run;
  const slept = sleepAfterFirstNudge(run, (at) => at + 2_000 + 30 * minute);
  for (let index = 0; index < 6; index++) {
    await open();
    await time.run(7 * minute);
  }
  // The renewal behind the nudge began on waking, after the window, and so did the look after it.
  assert.ok(slept());
  for (let index = 0; index < 12; index++) {
    await open();
    await time.run(7 * minute);
  }
  const vendor = host.vendor;
  for (let index = 0; index < 9; index++) {
    await open();
    await time.run(7 * minute);
  }
  const perAccount = (host.vendor - vendor) / host.ids.length;
  assert.ok(
    perAccount <= Math.ceil((63 * minute) / RENEW_AT) + 1,
    String(perAccount),
  );
  assert.deepEqual(new Set(await probe(time, host, 30 * minute)), new Set([0]));
  warmer.dispose();
  assert.deepEqual(host.reads.filter(Boolean), []);
  assert.ok(!logs.some((line) => /강제 갱신/.test(line)));
});

test("Windows 형 호스트에서 배우려고 보낸 조회 뒤 기계가 3시간 잠들어 깨어난 배경 갱신이 멈추면 그 창 뒤 확인도 버려, 다시 연 세션 뒤에 그 확인으로 미리 갱신하지 않는 호스트로 배우지 않음", async () => {
  const run = setup(WindowsHost);
  const { time, host, warmer, logs, open } = run;
  const slept = sleepAfterFirstNudge(run, (at) => at + 2_000 + 3 * 3_600_000);
  while (!slept()) {
    await open();
    await time.run(7 * minute);
  }
  assert.ok(logs.some((line) => /배경 갱신 멈춤/.test(line)));
  for (let index = 0; index < 9; index++) {
    await open();
    await time.run(7 * minute);
  }
  warmer.dispose();
  assert.deepEqual(host.reads.filter(Boolean), []);
  assert.ok(!logs.some((line) => /강제 갱신/.test(line)));
});

test("Windows 형 호스트가 창이 끝날 때까지 잠든 탓에 미리 갱신하지 않는 호스트로 잘못 배워도 한 시간 뒤 다시 확인해 강제 조회를 멈추고 창마다 공급사 호출이 한 번으로 돌아옴", async () => {
  const run = setup(WindowsHost);
  const { time, host, warmer, logs, open } = run;
  // Asleep until just after the window ends, so the look after it runs on time.
  const slept = sleepAfterFirstNudge(run, () => host.windowEnd() + 100);
  for (let index = 0; index < 4; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.ok(slept());
  assert.ok(logs.some((line) => /10초 전에 강제 갱신/.test(line)));
  // Forcing, the Windows build renews twice a window: behind the plain read, then again.
  const vendor = host.vendor;
  await time.run(20 * minute);
  assert.ok(host.reads.some(Boolean));
  assert.ok(
    (host.vendor - vendor) / host.ids.length >=
      2 * Math.floor((20 * minute) / HOST_WINDOW),
  );
  for (let index = 0; index < 7; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.ok(logs.some((line) => /강제 갱신을 멈춤/.test(line)));
  const forced = host.reads.filter(Boolean).length;
  const relearned = host.vendor;
  for (let index = 0; index < 9; index++) {
    await open();
    await time.run(7 * minute);
  }
  const perAccount = (host.vendor - relearned) / host.ids.length;
  assert.ok(
    perAccount <= Math.ceil((63 * minute) / RENEW_AT) + 1,
    String(perAccount),
  );
  assert.deepEqual(new Set(await probe(time, host, 30 * minute)), new Set([0]));
  warmer.dispose();
  assert.equal(host.reads.filter(Boolean).length, forced);
});

test("Linux 형 호스트에서 배우는 창 안에 다른 쪽이 강제 갱신해 미리 갱신하는 호스트로 잘못 배워도 한 시간 뒤 다시 확인해 강제 갱신으로 돌아감", async () => {
  const { time, host, warmer, logs, open } = setup(LinuxHost);
  let refreshed = false;
  host.onRead = (refresh) => {
    if (
      refreshed ||
      refresh ||
      !logs.some((line) => /다른 조회가 없어/.test(line))
    )
      return;
    refreshed = true;
    // Someone else forces a lookup ten seconds after the nudge, inside the window.
    time.clock.setTimer(() => void host.list(true), 10_000);
  };
  for (let index = 0; index < 7; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.ok(refreshed);
  assert.ok(!logs.some((line) => /강제 갱신/.test(line)));
  for (let index = 0; index < 7; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.ok(logs.some((line) => /10초 전에 강제 갱신/.test(line)));
  assert.deepEqual(new Set(await probe(time, host, 30 * minute)), new Set([0]));
  warmer.dispose();
});

test("Windows 형 호스트의 탐색이 매번 12초 걸려 창이 끝나기 10초 전 조회 뒤의 갱신이 창이 끝난 뒤에 시작해도, 미리 갱신하지 않는 호스트로 배우지 않아 강제 조회가 없고 창마다 공급사 호출은 한 번", async () => {
  const { time, host, warmer, logs, open } = setup(SlowWindowsHost);
  const waits: number[] = [];
  // Three and a half hours: the lesson lapses and is learned again three times.
  for (let index = 0; index < 30; index++) {
    waits.push(await open());
    await time.run(7 * minute);
  }
  warmer.dispose();
  assert.deepEqual(host.reads.filter(Boolean), []);
  assert.ok(!logs.some((line) => /강제 갱신/.test(line)));
  const perAccount = host.vendor / host.ids.length;
  assert.ok(
    perAccount <= Math.ceil((210 * minute) / RENEW_AT) + 1,
    String(perAccount),
  );
  // Only the first open, on an empty cache, waits for the whole lookup.
  assert.equal(waits[0], 12_000 + FETCH);
  assert.ok(
    waits.slice(1).every((ms) => ms < 12_000),
    String(waits),
  );
});

test("앱이 60초마다 폴링하는 Windows 형 호스트에서 한 계정의 조회가 15초 걸려 실패해 끝난 시각을 알리지 않아도, 6시간 동안 다른 조회가 갱신한다는 판단을 바꾸지 않고 공급사 호출을 하나도 더하지 않음", async () => {
  const runs = [];
  for (const warm of [false, true]) {
    const { time, host, warmer, logs, open } = setup(WindowsHost, warm);
    // The vendor times out on one account: the host answers its report for five minutes from when
    // the lookup failed, fifteen seconds after it began, which the report does not tell.
    host.failing.set("codex:fixture", 15_000);
    let polling = true;
    const poll = () => {
      if (!polling) return;
      void host.list(false);
      time.clock.setTimer(poll, minute);
    };
    poll();
    const waits: number[] = [];
    for (const end = time.now + 6 * 3_600_000; time.now < end; ) {
      waits.push(await open());
      await time.run(7 * minute);
    }
    polling = false;
    warmer.dispose();
    runs.push({
      vendor: host.vendor,
      renewals: host.renewedBy.length,
      reads: host.reads,
      waits,
      logs,
    });
  }
  const [without, warmed] = runs;
  assert.equal(warmed.vendor, without.vendor);
  assert.deepEqual(warmed.waits, without.waits);
  assert.deepEqual(warmed.reads.filter(Boolean), []);
  assert.deepEqual(
    warmed.logs.filter((line) => /다른 조회|호스트가/.test(line)),
    [],
  );
  // It only looked, once a window: the app's polls renew it in its last minute.
  assert.ok(
    warmed.reads.length <= warmed.renewals,
    `${warmed.reads.length} ${warmed.renewals}`,
  );
});

test("Linux 형 호스트에서 한 계정의 조회가 15초 걸려 실패해 그 창이 늦게 끝나도, 매시간 다시 배우는 창에서 세션 열기가 그 계정의 조회를 기다리지 않음(그 대가로 다른 계정은 배울 때마다 한 번 더 조회)", async () => {
  const { time, host, warmer, logs, open } = setup(LinuxHost);
  host.failing.set("codex:fixture", 15_000);
  for (let index = 0; index < 4; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.ok(logs.some((line) => /10초 전에 강제 갱신/.test(line)));
  // A session opens every ten seconds for two and a half hours: the lesson lapses and is learned
  // again twice, each time with a look after Claude's window, the failed lookup's still answered.
  const from = time.now;
  const waits: number[] = [];
  while (time.now - from < 150 * minute) {
    const ms = await open();
    waits.push(ms);
    await time.run(Math.max(0, 10_000 - ms));
  }
  warmer.dispose();
  // Looked at only once its window has surely ended, the failed lookup would leave the next session
  // open waiting for it in every hour; forced instead, it is renewed with Claude again.
  assert.ok(Math.max(...waits) < 5_000, String(Math.max(...waits)));
  const claude = host.lookups.get("claude:fixture")!.filter((at) => at >= from);
  const again = claude
    .slice(1)
    .filter((at, index) => at - claude[index] < RENEW_AT - 1_000).length;
  assert.ok(again <= 2, String(again));
});
test("앱 폴링이 없는 Windows 형 호스트에서 한 계정의 조회가 마감 20초까지 걸려 실패해도, 그 창이 끝나기 전에 시작한 갱신을 늦은 갱신으로 보지 않아 미리 갱신하지 않는 호스트로 배우지 않고 강제 조회가 없음", async () => {
  const { time, host, warmer, logs, open } = setup(WindowsHost);
  host.failing.set("codex:fixture", 20_000);
  for (let index = 0; index < 30; index++) {
    await open();
    await time.run(7 * minute);
  }
  warmer.dispose();
  assert.deepEqual(host.reads.filter(Boolean), []);
  assert.ok(!logs.some((line) => /강제 갱신/.test(line)));
  const perAccount = host.vendor / host.ids.length;
  assert.ok(
    perAccount <= Math.ceil((210 * minute) / RENEW_AT) + 1,
    String(perAccount),
  );
});

test("Linux 형 호스트의 계정이 모두 로그인 거부처럼 곧바로 실패해 보고서가 끝난 시각을 알리지 않아도, 본 때로 창 끝을 좁혀 미리 갱신하지 않는 호스트로 배우고 세션 열기가 기다리지 않음", async () => {
  const { time, host, warmer, logs, open } = setup(LinuxHost);
  for (const id of host.ids) host.failing.set(id, 500);
  for (let index = 0; index < 9; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.ok(logs.some((line) => /10초 전에 강제 갱신/.test(line)));
  assert.deepEqual(new Set(await probe(time, host, 30 * minute)), new Set([0]));
  warmer.dispose();
});

test("앱이 60초마다 폴링하는 Windows 형 호스트에서 모든 계정의 조회가 15초 걸려 실패해도, 창 뒤 확인이 갱신이 끝날 때까지 2초마다 다시 읽지 않고 공급사 호출을 더하지 않음", async () => {
  const runs = [];
  for (const warm of [false, true]) {
    const { time, host, warmer, logs, open } = setup(WindowsHost, warm);
    for (const id of host.ids) host.failing.set(id, 15_000);
    let polling = true;
    const poll = () => {
      if (!polling) return;
      void host.list(false);
      time.clock.setTimer(poll, minute);
    };
    poll();
    for (const end = time.now + 3 * 3_600_000; time.now < end; ) {
      await open();
      await time.run(7 * minute);
    }
    polling = false;
    warmer.dispose();
    runs.push({
      vendor: host.vendor,
      renewals: host.renewedBy.length,
      reads: host.reads,
      logs,
    });
  }
  const [without, warmed] = runs;
  assert.equal(warmed.vendor, without.vendor);
  assert.deepEqual(warmed.reads.filter(Boolean), []);
  assert.deepEqual(
    warmed.logs.filter((line) => /다른 조회|호스트가/.test(line)),
    [],
  );
  // A look that finds the renewal still running reads again once it may have ended, not sooner.
  assert.ok(
    warmed.reads.length <= 1.5 * warmed.renewals,
    `${warmed.reads.length} ${warmed.renewals}`,
  );
});

test("끝난 시각을 모르는 실패 보고서가 그 창이 끝났을 수도 있는 사이에 갱신되고 다른 보고서는 아직 창 안이면, 그 확인을 끝내 2초마다 다시 읽지 않음", async () => {
  const time = new Time();
  const start = time.now;
  // Codex failed a hundred seconds ago, as its report tells; Claude was just looked up.
  let codex: Lookup = {
    fetchedAt: start - 100_000,
    endedAt: start - 99_500,
    failed: true,
  };
  const claude: Lookup = { fetchedAt: start, endedAt: start + FETCH };
  const answer = () => [
    report("claude:fixture", claude),
    report("codex:fixture", codex),
  ];
  const reads: number[] = [];
  const warmer = new UsageWarmer(
    async () => {
      reads.push(time.now - start);
      return answer();
    },
    time.clock,
    () => undefined,
  );
  await time.run(FETCH);
  warmer.noteActivity(answer());
  // Someone renews Codex just after its window may have ended, as the app's polls do.
  await time.run(205_000 - FETCH);
  codex = {
    fetchedAt: time.now,
    endedAt: time.now + 500,
    failed: true,
  };
  await time.run(95_000);
  warmer.dispose();
  // It looked once Codex's window may have ended, and next after Claude's.
  assert.deepEqual(reads, [210_000]);
});

test("호스트가 끝났어야 할 창을 계속 답하면 2초 간격 재확인은 조회 마감까지만 하고 그 뒤로는 1분 간격", async () => {
  const time = new Time();
  let reads = 0;
  const fetched = { fetchedAt: time.now, endedAt: time.now + FETCH };
  const warmer = new UsageWarmer(
    async () => {
      reads++;
      return [report("claude:fixture", fetched)];
    },
    time.clock,
    () => undefined,
  );
  warmer.noteActivity([report("claude:fixture", fetched)]);
  await time.run(HOST_WINDOW + 10_000 + FETCH);
  const first = reads;
  // The lookup's twenty-second deadline and more, read every two seconds at most.
  await time.run(30_000);
  assert.ok(reads - first <= 9, String(reads - first));
  const capped = reads;
  await time.run(30 * minute);
  warmer.dispose();
  assert.ok(reads - capped <= 31, String(reads - capped));
});

test("로그인 변경 감시처럼 배경에서 읽은 사용량은 2시간 활동 창을 늘리지 않음", async () => {
  const { time, host, warmer, logs, open } = setup(LinuxHost);
  await open();
  /** Reads in the background every thirty seconds for `span`, as after a login change. */
  const watch = async (span: number) => {
    for (const end = time.now + span; time.now < end; ) {
      const { value, ms } = await time.timed(() => host.list(false));
      warmer.observe(value);
      await time.run(Math.max(0, 30_000 - ms));
    }
  };
  await watch(3 * 3_600_000);
  assert.ok(logs.some((line) => /배경 갱신 멈춤/.test(line)));
  const reads = host.reads.length;
  await watch(3_600_000);
  warmer.dispose();
  assert.equal(host.reads.length, reads);
});

test("세션 열기·사용량 조회가 2시간 없으면 공급사 호출과 조회를 멈추고 다시 쓰면 첫 창부터 데움", async () => {
  const { time, host, warmer, logs, open } = setup(LinuxHost);
  await open();
  await time.run(IDLE_LIMIT - minute);
  const vendor = host.vendor;
  const reads = host.reads.length;
  assert.ok(vendor > 40, String(vendor));
  await time.run(20 * minute);
  // Only the step due inside the last two hours still ran.
  assert.ok(
    host.vendor - vendor <= host.ids.length,
    String(host.vendor - vendor),
  );
  const stopped = host.vendor;
  const stoppedReads = host.reads.length;
  assert.ok(stoppedReads - reads <= 2);
  await time.run(6 * 3_600_000);
  assert.equal(host.vendor, stopped);
  assert.equal(host.reads.length, stoppedReads);
  assert.equal(time.pending, 0);
  assert.ok(logs.some((line) => /배경 갱신 멈춤/.test(line)));
  // Back in use: the lesson has lapsed, so the first window is nudged and looked at once it ends,
  // and that look renews it before the next session opens.
  assert.equal(await open(), FETCH);
  await time.run(7 * minute);
  assert.equal(await open(), 0);
  assert.equal(logs.filter((line) => /배경 갱신 시작/.test(line)).length, 2);
  warmer.dispose();
});

test("배경 갱신은 한 번에 하나만 돌고 종료하면 진행 중인 조회를 끊고 타이머를 남기지 않음", async () => {
  const time = new Time();
  let started = 0;
  let running = 0;
  let most = 0;
  const aborted: boolean[] = [];
  const read: HostRead = (_refresh, signal) => {
    started++;
    running++;
    most = Math.max(most, running);
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => {
        running--;
        aborted.push(true);
        reject(signal.reason);
      }),
    );
  };
  const warmer = new UsageWarmer(read, time.clock, () => undefined);
  const fetched = { fetchedAt: time.now, endedAt: time.now + FETCH };
  warmer.noteActivity([report("claude:fixture", fetched)]);
  // More activity while a step waits does not start a second one.
  await time.run(HOST_WINDOW + 30_000);
  assert.equal(started, 1);
  warmer.noteActivity([report("claude:fixture", fetched)]);
  await time.run(30 * minute);
  assert.equal(started, 1);
  assert.equal(most, 1);
  warmer.dispose();
  await settle();
  assert.deepEqual(aborted, [true]);
  assert.equal(time.pending, 0);
  warmer.noteActivity([report("claude:fixture", fetched)]);
  await time.run(3_600_000);
  assert.equal(started, 1);
  assert.equal(time.pending, 0);

  // Disposed while it waits for its next step: the timer goes with it.
  let reads = 0;
  const idle = new UsageWarmer(
    async () => {
      reads++;
      return [];
    },
    time.clock,
    () => undefined,
  );
  idle.noteActivity([
    report("claude:fixture", { fetchedAt: time.now, endedAt: time.now }),
  ]);
  assert.equal(time.pending, 1);
  idle.dispose();
  assert.equal(time.pending, 0);
  await time.run(3_600_000);
  assert.equal(reads, 0);
});

test("배경 갱신 조회가 실패하면 1분 뒤 다시 시도하고 실패를 한 번만 알림", async (t) => {
  const time = new Time();
  let reads = 0;
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: string) => void warnings.push(line));
  const warmer = new UsageWarmer(
    async () => {
      reads++;
      throw Error("synthetic host unavailable");
    },
    time.clock,
    () => undefined,
  );
  const fetched = { fetchedAt: time.now, endedAt: time.now + FETCH };
  warmer.noteActivity([report("claude:fixture", fetched)]);
  await time.run(HOST_WINDOW + 10 * minute);
  warmer.dispose();
  assert.ok(reads >= 9 && reads <= 11, String(reads));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /배경 갱신 실패, 60초 뒤 다시/);
  assert.equal(RETRY_AFTER, minute);
});

test("배경 갱신의 호스트 조회는 Aster 가 세션 열기에 쓰는 사용량을 쓰지도 채우지도 않음", async () => {
  const calls: string[][] = [];
  let at = Date.parse("2026-11-14T00:00:00Z");
  const reader = new UsageReader(
    async (_command, args) => {
      calls.push(args);
      return JSON.stringify([
        {
          id: "claude:fixture",
          sourceId: "claude",
          account: {},
          fetchedAt: new Date(at).toISOString(),
          report: { status: "available" },
        },
      ]);
    },
    () => at,
  );
  const command = { file: "synthetic", args: [] };
  const signal = new AbortController().signal;
  const first = await reader.read(command, signal);
  at += 1_000;
  const looked = await reader.lookup(command, signal, true);
  assert.notEqual(looked[0].fetchedAt, first[0].fetchedAt);
  assert.deepEqual(calls.at(-1)?.slice(-1), ["--refresh"]);
  // The session's reports are still the ones it read, within their own minute.
  assert.equal(
    (await reader.read(command, signal))[0].fetchedAt,
    first[0].fetchedAt,
  );
  assert.equal(calls.length, 2);
  await reader.lookup(command, signal);
  assert.ok(!calls.at(-1)?.includes("--refresh"));
  reader.dispose();
  await assert.rejects(reader.lookup(command, signal));
});

test("앞서간 시계로 만들어 조회 시각이 30일 뒤인 보고서로는 단계를 잡지 않아 데몬 조회를 되풀이하지 않고, 지금 시각에 조회한 보고서가 오면 다시 데움", async () => {
  const time = new Time();
  const ahead = {
    fetchedAt: time.now + 30 * DAY,
    endedAt: time.now + 30 * DAY + FETCH,
  };
  let answer = ahead;
  let reads = 0;
  const warmer: UsageWarmer = new UsageWarmer(
    async () => {
      // Ends a loop the warmer would not leave on its own.
      if (++reads > 100) warmer.dispose();
      return [report("claude:fixture", answer)];
    },
    time.clock,
    () => undefined,
  );
  warmer.noteActivity([report("claude:fixture", ahead)]);
  await time.run(10 * minute);
  assert.equal(reads, 0);
  assert.equal(time.pending, 0);
  // Looked up since, by the clock as it is: looked at once its window is over, as before.
  answer = { fetchedAt: time.now, endedAt: time.now + FETCH };
  warmer.noteActivity([report("claude:fixture", answer)]);
  await time.run(FETCH + HOST_WINDOW + LATE_CHECK - 1_000);
  assert.equal(reads, 0);
  await time.run(2_000);
  assert.equal(reads, 1);
  warmer.dispose();
  assert.ok(time.longest <= TIMEOUT_MAX, String(time.longest));
});

test("시계가 30일 뒤로 바뀌어도 그 전에 본 보고서·배운 것·활동 시각으로 단계를 잡지 않아 미리 갱신하지 않는 호스트에 조회를 되풀이하지 않고, 다시 조회된 뒤로는 데움", async () => {
  const { time, host, warmer, logs, open } = setup(LinuxHost);
  for (let index = 0; index < 4; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.ok(logs.some((line) => /10초 전에 강제 갱신/.test(line)));
  const reads = host.reads.length;
  host.onRead = () => {
    // Ends a loop the warmer would not leave on its own.
    if (host.reads.length - reads > 100) warmer.dispose();
  };
  // NTP sets the clock back thirty days. The host's cache, timed by that clock, answers what it
  // looked up before as current until the clock catches up.
  time.setBack(30 * DAY);
  await time.run(3 * 3_600_000);
  assert.ok(host.reads.length - reads <= 2, String(host.reads.length - reads));
  assert.equal(time.pending, 0);
  // Looked up anew (the app's refresh button): sessions find the cache current again.
  await time.timed(() => host.list(true));
  for (let index = 0; index < 9; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.deepEqual(new Set(await probe(time, host, 30 * minute)), new Set([0]));
  warmer.dispose();
  assert.ok(time.longest <= TIMEOUT_MAX, String(time.longest));
});

test("시계가 30일 뒤로 바뀐 뒤 다시 조회된 보고서는 데우되, 그 전에 배운 호스트 방식은 다시 배우고 세션 열기가 없으면 2시간 안에 멈춤", async () => {
  for (const HostType of [LinuxHost, WindowsHost]) {
    const { time, host, warmer, logs, open } = setup(HostType);
    for (let index = 0; index < 4; index++) {
      await open();
      await time.run(7 * minute);
    }
    time.setBack(30 * DAY);
    const setBack = time.now;
    // Someone looks the reports up anew (the app's refresh button); no session opens since.
    await time.timed(() => host.list(true));
    const reads: number[] = [];
    host.onRead = (refresh) => {
      if (!refresh) reads.push(time.now);
      // Ends a loop the warmer would not leave on its own.
      if (reads.length > 200) warmer.dispose();
    };
    await time.run(3 * 3_600_000);
    // What it learned before may be of any age now, so the next window teaches it again: a nudge
    // before the window ends, and a look after it. The first read is timed from before.
    assert.ok(
      reads.some(
        (at, index) =>
          index >= 2 &&
          at < setBack + 15 * minute &&
          at - reads[index - 1] < minute,
      ),
      `${HostType.name} ${reads.slice(0, 4).map((at) => at - setBack)}`,
    );
    assert.ok(
      reads.every((at) => at < setBack + IDLE_LIMIT + 10 * minute),
      HostType.name,
    );
    assert.ok(
      logs.some((line) => /배경 갱신 멈춤/.test(line)),
      HostType.name,
    );
    assert.equal(time.pending, 0, HostType.name);
    warmer.dispose();
  }
});

test("멈춰 있던 사이 시계가 30일 뒤로 바뀌어도, 다시 연 세션이 읽은 보고서로 단계를 잡아 데움", async () => {
  const { time, host, warmer, logs, open } = setup(LinuxHost);
  for (let index = 0; index < 4; index++) {
    await open();
    await time.run(7 * minute);
  }
  await time.run(IDLE_LIMIT);
  assert.ok(logs.some((line) => /배경 갱신 멈춤/.test(line)));
  assert.equal(time.pending, 0);
  time.setBack(30 * DAY);
  // Looked up anew (the app's refresh button), then a session opens.
  await time.timed(() => host.list(true));
  const reads = host.reads.length;
  await open();
  // Timed from the report the session read: nothing is due before its window nears its end.
  await time.run(4 * minute);
  assert.equal(host.reads.length, reads);
  for (let index = 0; index < 9; index++) {
    await open();
    await time.run(7 * minute);
  }
  assert.deepEqual(new Set(await probe(time, host, 30 * minute)), new Set([0]));
  warmer.dispose();
  assert.ok(time.longest <= TIMEOUT_MAX, String(time.longest));
});

test("시계가 30일 뒤로 바뀌기 전에 잡은 창 뒤 확인은 버려, 그 뒤 다시 조회된 보고서를 2초마다 다시 읽지 않음", async () => {
  const { time, host, warmer, open } = setup(WindowsHost);
  let polling = true;
  const poll = () => {
    if (!polling) return;
    void host.list(false);
    time.clock.setTimer(poll, minute);
  };
  poll();
  await open();
  await time.run(2 * minute);
  const reads = host.reads.length;
  host.onRead = () => {
    // Ends a loop the warmer would not leave on its own.
    if (host.reads.length - reads > 100) warmer.dispose();
  };
  time.setBack(30 * DAY);
  // Someone looks the reports up anew (the app's refresh button), and the app polls on.
  await time.timed(() => host.list(true));
  await time.run(30 * minute);
  polling = false;
  warmer.dispose();
  // It only looks, about once a window.
  assert.ok(host.reads.length - reads <= 8, String(host.reads.length - reads));
  assert.deepEqual(host.reads.filter(Boolean), []);
  assert.ok(time.longest <= TIMEOUT_MAX, String(time.longest));
});

test("실제 타이머는 setTimeout 이 담지 못하는 지연을 담을 수 있는 최대로 줄여 곧바로 돌지 않음", async (t) => {
  const warnings: string[] = [];
  t.mock.method(
    process,
    "emitWarning",
    (warning: unknown) => void warnings.push(String(warning)),
  );
  let ran = false;
  const timer = realClock.setTimer(() => {
    ran = true;
  }, 30 * DAY);
  await new Promise((resolve) => setTimeout(resolve, 50));
  realClock.clearTimer(timer);
  assert.equal(ran, false);
  assert.deepEqual(warnings, []);
});

test("배운 지 1시간이 되는 경계를 두 출처의 보고서가 사이에 두어도 1초 간격 조회를 되풀이하지 않음", async () => {
  const time = new Time();
  // A host whose lookups end at once, each looked up again once its window is over or when forced,
  // and so renewing nothing ahead.
  const at = { claude: time.now, codex: time.now };
  const sources = Object.keys(at) as (keyof typeof at)[];
  const answer = () =>
    sources.map((source) =>
      report(`${source}:fixture`, {
        fetchedAt: at[source],
        endedAt: at[source],
      }),
    );
  const reads: { at: number; refresh: boolean }[] = [];
  let learnedAt = NaN;
  const warmer = new UsageWarmer(
    async (refresh) => {
      reads.push({ at: time.now, refresh });
      for (const source of sources)
        if (refresh || time.now - at[source] >= HOST_WINDOW)
          at[source] = time.now;
      return answer();
    },
    time.clock,
    (line) => {
      if (/10초 전에 강제 갱신/.test(line)) learnedAt = time.now;
    },
  );
  warmer.noteActivity(answer());
  await time.run(15 * minute);
  assert.ok(Number.isFinite(learnedAt));
  // Someone refreshes each source alone, fifteen seconds apart, either side of an hour since the
  // warmer learned the host renews nothing ahead, and Aster reads them in the background.
  await time.run(learnedAt + TRUSTED - 10_000 - time.now);
  at.claude = time.now;
  await time.run(15_000);
  at.codex = time.now;
  warmer.observe(answer());
  const from = reads.length;
  await time.run(10 * minute);
  warmer.dispose();
  const plain = reads.filter((read) => !read.refresh).map((read) => read.at);
  const gaps = plain.slice(1).map((read, index) => read - plain[index]);
  assert.ok(Math.min(...gaps) >= 10_000, String(gaps));
  // Both forced together once the older is due, then learned again.
  assert.equal(reads.slice(from).filter((read) => read.refresh).length, 1);
  assert.ok(reads.length - from <= 5, String(reads.length - from));
});
