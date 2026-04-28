import type { AgentConfigReader } from "./wms-client.js";
import type { AgentEnv } from "./config.js";
import { log } from "./log.js";
import { MonsoonRunner, type ReadEvent } from "./monsoon-runner.js";
import { ReadAggregator } from "./read-aggregator.js";

/**
 * Reader supervisor: takes the latest config bundle and reconciles which
 * MonsoonReader subprocesses should be running.
 *
 * Lifecycle:
 *   - reader appeared in config + not running   → spawn
 *   - reader still in config + running          → check if cmdline drifted; restart if so
 *   - reader removed from config + running      → kill
 */
export class ReaderSupervisor {
  private readonly running = new Map<string, MonsoonRunner>();
  private readonly env: AgentEnv;
  private readonly aggregator: ReadAggregator;

  constructor(env: AgentEnv) {
    this.env = env;
    this.aggregator = new ReadAggregator(env);
    this.aggregator.start();
  }

  reconcile(readers: AgentConfigReader[]): void {
    const desired = new Map(readers.map((r) => [r.id, r]));

    // Stop runners that are no longer in config.
    for (const [id, runner] of this.running) {
      if (!desired.has(id)) {
        runner.stop();
        this.aggregator.flushAndDrop(id);
        this.running.delete(id);
      }
    }

    // Start or restart runners.
    for (const [id, spec] of desired) {
      const existing = this.running.get(id);
      if (!existing) {
        this.startRunner(spec);
        continue;
      }
      const newCmdline = makeCmdline(this.env, spec);
      if (existing.cmdline() !== newCmdline) {
        log.info("config drifted; restarting reader", {
          reader_id: id,
          name: spec.name,
        });
        existing.stop();
        this.aggregator.flushAndDrop(id);
        this.running.delete(id);
        this.startRunner(spec);
      }
    }
  }

  private startRunner(spec: AgentConfigReader): void {
    const runner = new MonsoonRunner(this.env, spec, {
      onReads: (ev: ReadEvent) => this.aggregator.enqueue(ev),
    });
    runner.start();
    this.running.set(spec.id, runner);
  }

  stopAll(): void {
    for (const runner of this.running.values()) runner.stop();
    this.running.clear();
    this.aggregator.stop();
  }

  list(): string[] {
    return [...this.running.keys()];
  }

  stats(): { posted: number; dropped: number; failedFlushes: number; runners: number } {
    return { ...this.aggregator.getStats(), runners: this.running.size };
  }
}

function makeCmdline(env: AgentEnv, spec: AgentConfigReader): string {
  return new MonsoonRunner(env, spec, { onReads: () => {} }).cmdline();
}
