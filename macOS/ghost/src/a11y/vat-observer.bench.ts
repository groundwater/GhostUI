type ObservedNode = {
  id: number;
  pid: number;
  expiresAt: number;
};

class VatObserverIndex {
  private readonly nodes = new Map<number, ObservedNode>();
  private readonly nodesByPid = new Map<number, Set<number>>();
  private readonly ttlOrder: ObservedNode[] = [];
  private ttlCursor = 0;

  register(node: ObservedNode): void {
    this.nodes.set(node.id, node);
    let pidSet = this.nodesByPid.get(node.pid);
    if (!pidSet) {
      pidSet = new Set<number>();
      this.nodesByPid.set(node.pid, pidSet);
    }
    pidSet.add(node.id);
    this.ttlOrder.push(node);
  }

  invalidateNode(id: number): number {
    return this.nodes.has(id) ? 1 : 0;
  }

  invalidatePid(pid: number): number {
    return this.nodesByPid.get(pid)?.size ?? 0;
  }

  cleanupExpired(now: number): number {
    let removed = 0;
    while (this.ttlCursor < this.ttlOrder.length) {
      const node = this.ttlOrder[this.ttlCursor];
      if (node.expiresAt > now) break;
      this.ttlCursor += 1;
      const live = this.nodes.get(node.id);
      if (!live || live.expiresAt !== node.expiresAt) continue;
      this.nodes.delete(node.id);
      const pidSet = this.nodesByPid.get(node.pid);
      if (pidSet) {
        pidSet.delete(node.id);
        if (pidSet.size === 0) this.nodesByPid.delete(node.pid);
      }
      removed += 1;
    }
    return removed;
  }

  get size(): number {
    return this.nodes.size;
  }
}

function nowMs(): number {
  return performance.now();
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function formatNsPerOp(ms: number, ops: number): string {
  return `${((ms * 1e6) / ops).toFixed(1)}ns/op`;
}

function bench(label: string, ops: number, fn: () => number): void {
  const start = nowMs();
  const touched = fn();
  const elapsed = nowMs() - start;
  console.log(
    `${label.padEnd(34)} ${formatMs(elapsed).padStart(10)}  ${formatNsPerOp(elapsed, ops).padStart(14)}  touched=${touched}`,
  );
}

function seedIndex(nodeCount: number, pidCount: number, ttlMs: number): VatObserverIndex {
  const index = new VatObserverIndex();
  for (let i = 0; i < nodeCount; i += 1) {
    index.register({
      id: i + 1,
      pid: (i % pidCount) + 1,
      expiresAt: i * ttlMs,
    });
  }
  return index;
}

function runScenario(nodeCount: number, pidCount: number): void {
  const eventCount = 100_000;
  const ttlNodeCount = 50_000;
  const ttlBurstSize = 5;

  console.log(`\nScenario: ${nodeCount.toLocaleString()} observed nodes across ${pidCount.toLocaleString()} pid(s)`);
  console.log("Operation".padEnd(34), "Total".padStart(10), "Per Op".padStart(14), "Details");
  console.log("-".repeat(80));

  bench("register steady-state nodes", nodeCount, () => {
    const index = seedIndex(nodeCount, pidCount, 60_000);
    return index.size;
  });

  {
    const index = seedIndex(nodeCount, pidCount, 60_000);
    bench("route pid invalidation events", eventCount, () => {
      let touched = 0;
      for (let i = 0; i < eventCount; i += 1) {
        touched += index.invalidatePid((i % pidCount) + 1);
      }
      return touched;
    });
  }

  {
    const index = seedIndex(nodeCount, pidCount, 60_000);
    bench("route exact-node invalidations", eventCount, () => {
      let touched = 0;
      for (let i = 0; i < eventCount; i += 1) {
        touched += index.invalidateNode((i % nodeCount) + 1);
      }
      return touched;
    });
  }

  {
    const index = new VatObserverIndex();
    for (let click = 0; click < ttlNodeCount / ttlBurstSize; click += 1) {
      const expiresAt = click * 3_000;
      for (let level = 0; level < ttlBurstSize; level += 1) {
        const id = click * ttlBurstSize + level + 1;
        index.register({
          id,
          pid: (id % pidCount) + 1,
          expiresAt,
        });
      }
    }
    bench("cleanup ttl-observed hot nodes", ttlNodeCount, () => {
      let removed = 0;
      for (let i = 0; i < ttlNodeCount; i += ttlBurstSize) {
        removed += index.cleanupExpired((i / ttlBurstSize) * 3_000);
      }
      return removed;
    });
  }
}

console.log("VAT observer synthetic benchmark");
console.log("Measures daemon-side bookkeeping cost for observed-node indexing and event fanout.");
console.log("It does not measure macOS AXObserver registration or native callback overhead.");

runScenario(10_000, 1);
runScenario(10_000, 10);
runScenario(10_000, 100);
