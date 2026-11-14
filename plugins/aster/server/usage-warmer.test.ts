import assert from "node:assert/strict";
import test from "node:test";
import { UsageReader } from "./accounts.ts";
import {
  HOST_WINDOW,
  IDLE_LIMIT,
  RENEW_AT,
  RETRY_AFTER,
  UsageWarmer,
  type HostRead,
  type WarmedReport,
  type WarmerClock,
} from "./usage-warmer.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Fake time: `run` fires timers in order, settling what each one started before the next. */
class Time {
  now = Date.parse("2026-11-14T00:00:00Z");
  private seq = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  readonly clock: WarmerClock = {
    now: () => this.now,
    setTimer: (run, ms) => {
      const id = ++this.seq;
      this.timers.set(id, { at: this.now + Math.max(0, ms), run });
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
  async run(ms: number) {
    assert.ok(ms >= 0, "time only moves forward");
    const end = this.now + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers)
        if (!next || entry[1].at < next[1].at) next = entry;
      if (!next || next[1].at > end) break;
      this.timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].run();
    }
    this.now = end;
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
const report = (
  id: string,
  lookup: { fetchedAt: number; endedAt: number },
) => ({
  id,
  fetchedAt: new Date(lookup.fetchedAt).toISOString(),
  successfulAt: new Date(lookup.endedAt).toISOString(),
});

/** A host that counts what reaches the vendor and which reads the warmer made. */
abstract class Host {
  vendor = 0;
  reads: boolean[] = [];
  /** When the warmer last read. */
  lastRead = -Infinity;
  readonly ids = ["claude:fixture", "codex:fixture"];
  protected readonly cache = new Map<
    string,
    { fetchedAt: number; endedAt: number }
  >();
  constructor(protected readonly time: Time) {}
  /** Who made each read that started a renewal (Windows build only). */
  renewedBy: string[] = [];
  abstract list(refresh: boolean, by?: string): Promise<WarmedReport[]>;
  /** What the warmer is given: the same reads, recorded. */
  readonly warmerRead: HostRead = (refresh) => {
    this.reads.push(refresh);
    this.lastRead = this.time.now;
    return this.list(refresh, "warmer");
  };
  protected async lookup(id: string) {
    const fetchedAt = this.time.now;
    this.vendor++;
    await this.time.sleep(FETCH);
    const lookup = { fetchedAt, endedAt: this.time.now };
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
 * read in its last minute renews them behind the answer, a read after it waits for the renewal, and
 * a forced read renews again after any renewal under way.
 */
class WindowsHost extends Host {
  /** Sources that share a discovery, each renewed apart, and how long its discovery takes. */
  protected readonly groups: {
    ids: string[];
    discovery: number;
    discoveredAt: number;
    renewal: Promise<void> | null;
  }[] = [
    {
      ids: this.ids,
      discovery: DISCOVERY,
      discoveredAt: -Infinity,
      renewal: null,
    },
  ];
  async list(refresh: boolean, by = "other") {
    await Promise.all(
      this.groups.map(async (group) => {
        if (refresh)
          return await (group.renewal
            ? group.renewal.then(() => this.renew(group, by))
            : this.renew(group, by));
        const state = this.state(group);
        if (group.renewal) {
          if (state === "expired") await group.renewal;
        } else if (state === "expired") await this.renew(group, by);
        else if (state === "due") void this.renew(group, by);
      }),
    );
    return this.ids.map((id) => report(id, this.cache.get(id)!));
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
    const task = (async () => {
      await this.time.sleep(group.discovery);
      group.discoveredAt = this.time.now;
      await Promise.all(group.ids.map((id) => this.lookup(id)));
    })();
    const running: Promise<void> = task.finally(() => {
      if (group.renewal === running) group.renewal = null;
    });
    group.renewal = running;
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

test("세션 열기·사용량 조회가 2시간 없으면 공급사 호출과 조회를 멈추고 다시 쓰면 배운 대로 이어감", async () => {
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
  // Back in use: the host is already known, so the first window is warmed.
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
