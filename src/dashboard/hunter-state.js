/**
 * hunter-state.js — Shared state singleton for real-time dashboard
 * The hunter emits events here, the dashboard server reads them via SSE.
 */
import { EventEmitter } from 'events';

class HunterState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.state = {
      status: 'initializing',     // initializing | waiting | hunting | qualifying | sleeping | reflecting
      currentPlatform: null,
      platformIndex: 0,
      totalPlatforms: 0,
      cycleNumber: 0,
      cycleStartTime: null,
      currentLead: null,
      stats: { rawLeads: 0, qualifiedLeads: 0, totalCycles: 0, bestPlatform: 'none' },
      recentLogs: [],
      leads: [],
      memory: {},
      aiTargetsFound: 0,
      adaptiveQueries: 0,
      lastReflection: '',
      uptime: Date.now(),
    };
  }

  update(partial) {
    Object.assign(this.state, partial);
    this.emit('update', this.state);
  }

  addLog(msg, level = 'INFO') {
    const entry = { ts: new Date().toISOString(), msg, level };
    this.state.recentLogs.push(entry);
    if (this.state.recentLogs.length > 200) this.state.recentLogs.shift();
    this.emit('log', entry);
  }

  getState() { return { ...this.state }; }
}

const hunterState = new HunterState();
export default hunterState;
