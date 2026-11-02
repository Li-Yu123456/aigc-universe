'use strict';
(function(){
// 确定性伪随机（C3 时间单向）：同种子 = 同时间线。


// mulberry32：32 位确定性 PRNG，足够快、可移植、无依赖。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.f = mulberry32(seed);
  }
  float() {
    return this.f();
  }
  int(n) {
    return Math.floor(this.f() * n); // [0, n)
  }
  chance(p) {
    return this.f() < p;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}



// 算力池（总世界基底）：环面网格 + 守恒账本（C1/C2/C4 的执行）。
// 一切算力流动走账本：注入（再生/实验注入）、耗散（代谢/冲突/死亡残骸）；
// 收割与偷取是位置转移，不动账本。


class Grid {
  constructor(cfg, rng) {
    this.w = cfg.width;
    this.h = cfg.height;
    this.cfg = cfg;
    this.cells = new Int32Array(this.w * this.h);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = Math.round(rng.float() * cfg.cellCap);
    }
    this.book = { init: this.total(), inj: 0, dis: 0 }; // 守恒账本
  }

  idx(x, y) {
    return ((y % this.h + this.h) % this.h) * this.w + ((x % this.w + this.w) % this.w);
  }

  total() {
    let s = 0;
    for (let i = 0; i < this.cells.length; i++) s += this.cells[i];
    return s;
  }

  // C2：每格再生 regrow/tick，封顶 cellCap。返回实际注入量。
  regrow() {
    const { regrow, cellCap } = this.cfg;
    let inj = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const add = Math.min(regrow, cellCap - this.cells[i]);
      if (add > 0) {
        this.cells[i] += add;
        inj += add;
      }
    }
    this.book.inj += inj;
    return inj;
  }

  harvest(i, amount) {
    const got = Math.min(this.cells[i], amount);
    this.cells[i] -= got;
    return got;
  }

  dissipate(n) {
    this.book.dis += n;
  }

  inject(n) {
    this.book.inj += n;
  }
}



// Agent：一段会自主行动的信息模式（子世界居民）。
// 基因组四轴：metab 代谢 / vision 视野 / coop 合作倾向 / mem 记忆深度。


let NEXT_ID = 1;
function resetIds() {
  NEXT_ID = 1;
}

class Agent {
  constructor(genome, energy, x, y, founder, species) {
    this.id = NEXT_ID++;
    this.genome = genome; // {metab, vision, coop, mem}
    this.energy = energy;
    this.x = x;
    this.y = y;
    this.age = 0;
    this.founder = founder === undefined ? this.id : founder; // 谱系锚：始终指向初始始祖
    this.species = species || 'agent';
    this.mem = new Map(); // 背叛者记忆：id -> tick（FIFO 受 mem 深度限制）
    this.ccCount = 0;
    this.offspring = 0;
    this.harvestTotal = 0;
  }

  remember(id, tick, cap) {
    if (cap <= 0) return;
    if (this.mem.has(id)) this.mem.delete(id);
    this.mem.set(id, tick);
    if (this.mem.size > cap) this.mem.delete(this.mem.keys().next().value);
  }

  distrusts(id) {
    return this.mem.has(id);
  }

  clone(childGenome, energy, x, y) {
    return new Agent(childGenome, energy, x, y, this.founder, this.species);
  }
}

// 基因采样：范围 [lo, hi] 均匀
function sampleGenome(rng, ranges) {
  const g = {};
  for (const k of Object.keys(ranges)) {
    const [lo, hi] = ranges[k];
    g[k] = lo + rng.float() * (hi - lo);
  }
  g.metab = Math.round(g.metab);
  g.vision = Math.round(g.vision);
  g.mem = Math.round(g.mem);
  g.coop = +g.coop.toFixed(3);
  return g;
}

// 变异：每个基因以 pMut 概率在原始范围内重采样（大步变异，简化演化搜索）
function mutateGenome(rng, genome, ranges, pMut) {
  const g = { ...genome };
  for (const k of Object.keys(ranges)) {
    if (rng.chance(pMut)) {
      const [lo, hi] = ranges[k];
      let v = lo + rng.float() * (hi - lo);
      if (k === 'metab' || k === 'vision' || k === 'mem') v = Math.round(v);
      if (k === 'coop') v = +v.toFixed(3);
      g[k] = v;
    }
  }
  return g;
}



// 平台宇宙：可分步推进的有状态宇宙（与 engine/sim.js 主循环同源——改物理须两处同步）。
// 平台特色：访客围观实时演化 + 拨杆干预（注入率/偷窃额/天灾）。






const DEF = {
  width: 40, height: 40, cellCap: 300, regrow: 8,
  count: 100, energy: 500,
  genome: { metab: [80, 160], vision: [1, 3], coop: [0.3, 0.8], mem: [0, 4] },
  threshold: 1500, cost: 700, pMut: 0.15,
  steal: 100, conflict: 50, synergyCut: 30,
  maxPop: 8000,
};

class Universe {
  constructor(over) {
    const cfg = { ...DEF, ...(over || {}) };
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed || 1);
    this.grid = new Grid({ width: cfg.width, height: cfg.height, cellCap: cfg.cellCap, regrow: cfg.regrow }, this.rng);
    resetIds();
    this.agents = [];
    for (let i = 0; i < cfg.count; i++) {
      this.agents.push(new Agent(sampleGenome(this.rng, cfg.genome), cfg.energy,
        this.rng.int(this.grid.w), this.rng.int(this.grid.h)));
    }
    for (const a of this.agents) this.grid.book.init += a.energy;
    this.t = 0;
    this.history = []; // 每 10 tick 一条快照
    this.pendingPerturb = null;
  }

  bestCell(a) {
    const v = a.genome.vision;
    let bx = a.x, by = a.y, be = this.grid.cells[this.grid.idx(a.x, a.y)];
    for (let dy = -v; dy <= v; dy++) for (let dx = -v; dx <= v; dx++) {
      if (!dx && !dy) continue;
      const i = this.grid.idx(a.x + dx, a.y + dy);
      if (this.grid.cells[i] > be) { be = this.grid.cells[i]; bx = a.x + dx; by = a.y + dy; }
    }
    return { x: bx, y: by };
  }

  play() {
    const { steal, conflict, synergyCut } = this.cfg;
    const groups = new Map();
    const bw = Math.ceil(this.grid.w / 2);
    for (const a of this.agents) {
      const key = Math.floor(((a.y % this.grid.h + this.grid.h) % this.grid.h) / 2) * bw +
                  Math.floor(((a.x % this.grid.w + this.grid.w) % this.grid.w) / 2);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    let cc = 0, cd = 0, dd = 0;
    for (const grp of groups.values()) {
      if (grp.length < 2) continue;
      this.rng.shuffle(grp);
      for (let i = 0; i + 1 < grp.length; i += 2) {
        const a = grp[i], b = grp[i + 1];
        const aC = !a.distrusts(b.id) && this.rng.chance(a.genome.coop);
        const bC = !b.distrusts(a.id) && this.rng.chance(b.genome.coop);
        if (aC && bC) { cc++; a.ccCount++; b.ccCount++; a.synCut = synergyCut; b.synCut = synergyCut; }
        else if (aC !== bC) {
          cd++;
          const victim = aC ? a : b, thief = aC ? b : a;
          const amt = Math.min(steal, victim.energy);
          victim.energy -= amt; thief.energy += amt;
          victim.remember(thief.id, 0, victim.genome.mem);
        } else {
          dd++;
          for (const p of [a, b]) {
            const c = Math.min(conflict, p.energy);
            p.energy -= c; this.grid.dissipate(c);
          }
        }
      }
    }
    return { cc, cd, dd };
  }

  step() {
    const cfg = this.cfg;
    this.t++;
    let births = 0, deaths = 0;
    for (const a of this.agents) a.synCut = 0;
    this.grid.regrow();
    this.rng.shuffle(this.agents);
    for (const a of this.agents) {
      const c = this.bestCell(a);
      a.x = c.x; a.y = c.y;
      const got = this.grid.harvest(this.grid.idx(a.x, a.y), 200);
      a.energy += got; a.harvestTotal += got;
    }
    const g = this.play();
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const a = this.agents[i];
      a.age++;
      const due = Math.max(0, a.genome.metab - (a.synCut || 0));
      const pay = Math.min(a.energy, due);
      a.energy -= pay; this.grid.dissipate(pay);
      if (a.energy <= 0) { this.agents.splice(i, 1); deaths++; }
    }
    const n0 = this.agents.length;
    for (let i = 0; i < n0 && this.agents.length < cfg.maxPop; i++) {
      const a = this.agents[i];
      if (a.energy >= cfg.threshold) {
        const gn = {};
        for (const k of Object.keys(cfg.genome)) {
          gn[k] = this.rng.chance(cfg.pMut)
            ? (() => { const [lo, hi] = cfg.genome[k]; let v = lo + this.rng.float() * (hi - lo);
                if (['metab', 'vision', 'mem'].includes(k)) v = Math.round(v); return v; })()
            : a.genome[k];
        }
        const child = a.clone(gn, cfg.cost,
          (a.x + this.rng.int(3) - 1 + this.grid.w) % this.grid.w,
          (a.y + this.rng.int(3) - 1 + this.grid.h) % this.grid.h);
        a.energy -= cfg.cost;
        this.agents.push(child); births++;
      }
    }
    if (this.pendingPerturb) {
      this.rng.shuffle(this.agents);
      const k = Math.round(this.agents.length * this.pendingPerturb);
      for (let i = 0; i < k; i++) this.grid.dissipate(this.agents[i].energy);
      this.agents.splice(0, k);
      deaths += k;
      this.pendingPerturb = null;
    }
    if (this.t % 10 === 0 || this.agents.length === 0) {
      let m = 0, c = 0;
      for (const a of this.agents) { m += a.genome.metab; c += a.genome.coop; }
      const n = this.agents.length || 1;
      this.history.push({ t: this.t, pop: this.agents.length,
        coopAvg: +(c / n).toFixed(3), metabAvg: +(m / n).toFixed(1),
        cc: g.cc, cd: g.cd, dd: g.dd });
      if (this.history.length > 2000) this.history.shift();
    }
    return this.agents.length > 0;
  }

  // 平台干预
  setRegrow(v) { this.grid.cfg.regrow = Math.max(0, Math.min(200, Math.round(v))); }
  setSteal(v) { this.cfg.steal = Math.max(0, Math.min(400, Math.round(v))); }
  perturb(frac) { this.pendingPerturb = Math.max(0.05, Math.min(0.9, frac)); }

  snapshot(lite) {
    // lite 模式：网格降采样 20×20（均值聚合），dots 只传坐标+温度档——传输量降 90%，rAF 平滑由前端负责
    let cells, dots, w, h, cellsMax;
    if (lite) {
      w = 20; h = 20;
      const sx = Math.max(1, Math.floor(this.grid.w / w)), sy = Math.max(1, Math.floor(this.grid.h / h));
      cells = new Array(w * h);
      for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) {
        let s = 0, n = 0;
        for (let y = by * sy; y < Math.min((by + 1) * sy, this.grid.h); y++)
          for (let x = bx * sx; x < Math.min((bx + 1) * sx, this.grid.w); x++) { s += this.grid.cells[y * this.grid.w + x]; n++; }
        cells[by * w + bx] = Math.round(s / Math.max(1, n));
      }
      cellsMax = this.cfg.cellCap;
      dots = this.agents.slice(0, 1500).map((a) => [a.x, a.y, a.genome.coop > 0.5 ? 1 : 0]);
    } else {
      cells = Array.from(this.grid.cells);
      dots = this.agents.slice(0, 3000).map((a) => ({ x: a.x, y: a.y, e: a.energy, coop: a.genome.coop }));
      w = this.grid.w; h = this.grid.h; cellsMax = this.cfg.cellCap;
    }
    let m = 0, c = 0;
    for (const a of this.agents) { m += a.genome.metab; c += a.genome.coop; }
    const n = this.agents.length || 1;
    return {
      t: this.t,
      pop: this.agents.length,
      coopAvg: +(c / n).toFixed(3),
      metabAvg: +(m / n).toFixed(1),
      regrow: this.grid.cfg.regrow,
      steal: this.cfg.steal,
      cellTotal: this.grid.total(),
      book: { ...this.grid.book },
      w, h,
      cellsMax,
      cells, dots, history: this.history.slice(-400),
    };
  }
}



window.Universe = Universe;
})();