import type { AgentHandle } from "./registry-types.js";

/**
 * Registry of agent sessions currently seen by the hub. Agents register by
 * sending `agent.hello` right after opening the WebSocket. Multiple servers of
 * the same agent name reconnect freely; the newest session wins for pushes.
 */
class RegistryImpl {
  private byAgent = new Map<string, AgentHandle>();

  register(handle: {
    agent: string;
    capabilities: string[];
    modes: string[];
  }): AgentHandle {
    const handleOut: AgentHandle = {
      agent: handle.agent,
      capabilities: handle.capabilities,
      modes: handle.modes,
      registeredAt: Date.now(),
    };
    this.byAgent.set(handle.agent, handleOut);
    return handleOut;
  }

  remove(agent: string): void {
    this.byAgent.delete(agent);
  }

  has(agent: string): boolean {
    return this.byAgent.has(agent);
  }

  agents(): AgentHandle[] {
    return [...this.byAgent.values()];
  }

  /** Agents that declare one of the requested capabilities. */
  byCapability(kind: string): AgentHandle[] {
    return this.agents().filter((a) => a.capabilities.includes(kind));
  }

  allNames(): string[] {
    return [...this.byAgent.keys()];
  }
}

export const agentRegistry = new RegistryImpl();
