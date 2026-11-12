import { defineNode } from "../registry.js";
import { makeStage, makePlayer, makeFilmstrip, toolButton, readPixel } from "../view.js";
import { createCanvas, el } from "../../core/util.js";
import { api } from "../../core/api.js";
import { computeKeypointAlignment } from "../../imaging/keypointAlign.js";
import { sequenceFingerprint, sequenceSubjects, uploadSequence } from "../../tracking/frames.js";
import { runTrackingJob, trackingMatches } from "../../tracking/client.js";

const busy = ctx => !!ctx.local.trackingController;
const message = (ctx, text) => ctx.setLocal({ trackingMessage: text });
const sourceLabel = { tracking: "跟踪居中", interpolated: "轨迹插值 · 请检查", held: "保持可靠位置 · 请检查",
  untracked: "尚未跟踪 · 保留原图", manual: "人工中心", empty: "空帧" };
const pointText = p => `${Number(p.x.toFixed(2))}, ${Number(p.y.toFixed(2))}`;

async function startTracking(ctx) {
  if (busy(ctx)) return;
  const src = ctx.input("src"), projectId = ctx.store.projectId;
  const points = structuredClone(ctx.params().points || []);
  if (!src?.frames.length || !points.length) { ctx.toast("请连接序列帧，并在首帧选择参考点。"); return; }
  if (src.frames.length > 512 || src.w * src.h > 16 * 1024 * 1024) {
    ctx.toast("每组最多 512 帧，单帧最多 1600 万像素。"); return;
  }
  const controller = new AbortController();
  ctx.setLocal({ trackingController: controller, picking: false, centerPicking: false, showSource: false,
    trackingError: null, trackingMessage: "检查跟踪环境…" });
  try {
    const status = await api.trackingStatus();
    if (status.busy) throw new Error("另一个跟踪任务正在运行，请稍后重试。");
    if (!status.ready) throw new Error(status.error || "跟踪模型尚未准备好，请完成跟踪环境安装。");
    const sourceFingerprint = await sequenceFingerprint(src);
    const selectedOn = ctx.params().pointsFingerprint || ctx.params().tracking?.sourceFingerprint;
    if (selectedOn && selectedOn !== sourceFingerprint) throw new Error("图片内容已变化，请在首帧重新选点并跟踪；当前保留原图。");
    const assetIds = await uploadSequence(src, projectId, api, controller.signal,
      (done, total) => message(ctx, `准备图片 ${done}/${total}`));
    message(ctx, "加载模型并开始跟踪，首次运行需要稍等…");
    const result = await runTrackingJob(api, projectId, {
      assetIds, points, width: src.w, height: src.h,
    }, { signal: controller.signal, onProgress: job => message(ctx, `正在跟踪 ${job.done}/${job.total}`) });
    if (!ctx.card() || controller.signal.aborted || ctx.store.projectId !== projectId) return;
    const current = ctx.input("src");
    const saved = { ...result, sourceFingerprint, assetIds };
    const currentFingerprint = current && await sequenceFingerprint(current);
    if (!ctx.card() || controller.signal.aborted || ctx.store.projectId !== projectId) return;
    if (!current || !trackingMatches(saved, currentFingerprint, ctx.params().points)) {
      message(ctx, "输入或选点已变化，请重新跟踪。"); return;
    }
    ctx.set({ tracking: saved });
    message(ctx, `跟踪完成 · ${src.frames.length} 帧`);
  } catch (error) {
    ctx.setLocal({ trackingError: error.name === "AbortError" ? null : error.message });
    message(ctx, error.name === "AbortError" ? "跟踪已取消" : error.message);
    if (error.name !== "AbortError") ctx.toast(error.message, "error");
  } finally {
    if (ctx.local.trackingController === controller) ctx.setLocal({ trackingController: null });
  }
}

function clearPoints(ctx) {
  if (busy(ctx)) return;
  ctx.set({ points: [], pointsFingerprint: null, tracking: null });
  ctx.setLocal({ picking: true, centerPicking: false, trackingMessage: "第 1 点作为居中基准；可补充几个分散的躯干辅助点。" });
}

export function markSubjectCenter(ctx, index, center) {
  const src = ctx.input("src"), fingerprint = ctx.result()?.view?.sourceFingerprint;
  if (!src || index < 0 || index >= src.frames.length || !fingerprint) {
    ctx.toast("请先连接动画并等待主体分析完成。"); return;
  }
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)
      || center.x < 0 || center.x > src.w || center.y < 0 || center.y > src.h) {
    ctx.toast("主体中心必须在原图画布内。"); return;
  }
  const p = ctx.params();
  const centers = p.subjectCentersFingerprint === fingerprint ? p.subjectCenters : {};
  ctx.set({ subjectCenters: { ...centers, [index]: { x: center.x, y: center.y } }, subjectCentersFingerprint: fingerprint,
    editFrame: index + 1, editCenterX: center.x, editCenterY: center.y });
  ctx.setLocal({ picking: false, centerPicking: false, showSource: false, trackingMessage: "" });
  ctx.local.seekTrackingFrame?.(index);
}

defineNode({
  type: "keypointAlign", title: "主体居中", category: "处理", icon: "⌖",
  help: "用跟踪轨迹居中：首个选点定义中心，多点拟合支持旋转和缩放；系统自动补充附近辅助点并反向验证。跟踪失败时使用轨迹插值或保持可靠位置，不使用轮廓中心。",
  inputs: [{ name: "src", label: "序列帧", accepts: ["frames"] }],
  outputs: [{ name: "out", label: "序列帧", kind: "frames" }],
  size: { w: 320, h: 330 },
  defaults: () => ({
    points: [], pointsFingerprint: null, tracking: null, minPoints: 2, tolerance: 2, alphaThreshold: 16,
    subjectCenters: {}, subjectCentersFingerprint: null, editFrame: 1, editCenterX: 0, editCenterY: 0,
  }),

  async evaluate(p, { src }) {
    if (!src.frames.length) return { outputs: { out: { ...src } }, info: { text: "空动画" } };
    const sourceFingerprint = await sequenceFingerprint(src);
    const trackingUsable = trackingMatches(p.tracking, sourceFingerprint, p.points);
    const selectedOn = p.pointsFingerprint || p.tracking?.sourceFingerprint;
    const pointsUsable = !selectedOn || selectedOn === sourceFingerprint;
    const stale = !!p.tracking && !trackingUsable;
    const a = computeKeypointAlignment(trackingUsable ? p.tracking : null, {
      width: src.w, height: src.h, minPoints: p.minPoints, tolerance: p.tolerance,
      subjects: sequenceSubjects(src, p.alphaThreshold ?? 16),
      durations: src.frames.map(frame => frame.duration || 1000 / Math.max(1, src.fps || 12)),
      subjectCenters: p.subjectCentersFingerprint === sourceFingerprint ? p.subjectCenters : {},
    });
    const frames = src.frames.map((frame, i) => {
      const canvas = createCanvas(a.outW, a.outH), g = canvas.getContext("2d");
      g.imageSmoothingEnabled = false;
      g.drawImage(frame.canvas, a.offsets[i].dx, a.offsets[i].dy);
      return { ...frame, canvas };
    });
    const review = a.reviewFrames.length, fallback = a.fallbackFrames.length, empty = a.emptyFrames.length;
    const waiting = a.untrackedFrames.length;
    return {
      outputs: { out: { ...src, frames, w: a.outW, h: a.outH } },
      info: { text: `${frames.length} 帧 · ${a.outW}×${a.outH} · ${waiting ? "等待跟踪" : "跟踪居中"}${fallback ? ` · 轨迹回退 ${fallback} 帧` : ""}${empty ? ` · 空帧 ${empty}` : ""}${review ? ` · ${review} 帧需检查` : ""}`,
        review, fallback, empty, stale, untrackedCount: waiting },
      view: { ...a, sourceFingerprint, trackingUsable, pointsUsable },
    };
  },

  mount(ctx) {
    ctx.local.picking = false;
    ctx.local.showGuides = true;
    const stage = makeStage({ fit: "integer" });
    const status = el("div", { class: "tracking-status", role: "status" });
    const controls = el("div", { class: "tracking-controls" });
    const label = el("span", { class: "mono" });
    const describeFrame = i => {
      if (busy(ctx)) { status.textContent = ctx.local.trackingMessage; return; }
      if (ctx.local.centerPicking) { status.textContent = "在原图点击这一帧的人物中心，标记后自动居中。"; return; }
      if (ctx.local.picking) { status.textContent = `首帧选点 · 已选 ${ctx.params().points?.length || 0} 个`; return; }
      const d = ctx.result()?.view?.diagnostics[i];
      const text = sourceLabel[d?.source] || "等待跟踪…";
      status.textContent = ctx.local.trackingError ? ctx.local.trackingError
        : `第 ${i + 1} 帧 · ${text}${ctx.result()?.info?.stale ? " · 轨迹已过期" : ""}`;
    };
    const player = makePlayer(stage, {
      autoplay: false, fps: () => ctx.input("src")?.fps || 12, emptyText: "连接序列帧，选择中心并跟踪",
      onFrame: (i, n, playing) => { label.textContent = `${i + 1}/${n}`; play.textContent = playing ? "暂停" : "播放"; describeFrame(i); },
      overlay(g, w, _h, index) {
        const p = ctx.params(), a = ctx.result()?.view;
        const sourceView = ctx.local.picking || ctx.local.centerPicking || ctx.local.showSource || !a;
        const tracks = a?.trackingUsable ? p.tracking?.tracks?.[index] : null;
        const points = ctx.local.picking || index === 0 && !tracks ? a?.pointsUsable === false ? [] : p.points : tracks;
        const offset = sourceView ? { dx: 0, dy: 0 } : a.offsets[index];
        if (!offset) return;
        if (a && ctx.local.showGuides && !ctx.local.picking) {
          g.lineWidth = Math.max(0.5, w / 500);
          g.strokeStyle = "rgba(80,220,255,0.6)";
          g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, _h);
          g.moveTo(0, _h / 2); g.lineTo(w, _h / 2); g.stroke();
          const center = a.centers[index];
          g.strokeStyle = "#ffd45e";
          if (center) {
            const x = center.x + offset.dx, y = center.y + offset.dy, r = Math.max(2, w / 100);
            g.beginPath(); g.moveTo(x - r, y); g.lineTo(x + r, y);
            g.moveTo(x, y - r); g.lineTo(x, y + r); g.stroke();
          }
        }
        (points || []).forEach((point, j) => {
          if (!point) return;
          const x = point[0] + offset.dx, y = point[1] + offset.dy;
          const visible = ctx.local.picking || !tracks || p.tracking.visibility[index]?.[j];
          const recovered = p.tracking?.pointStatus?.[index]?.[j] === "recovered";
          const accepted = ctx.local.picking || !tracks || a?.diagnostics[index]?.inlierIndices.includes(j);
          g.strokeStyle = !visible ? "#ff6464" : !accepted ? "#ffc05a" : recovered ? "#50dcff" : "#50f0b0";
          const r = Math.max(1, w / 150) * (j === 0 ? 1.5 : 1);
          g.lineWidth = Math.max(0.5, w / 300);
          g.setLineDash(visible ? [] : [r, r]);
          g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
          g.setLineDash([]);
          g.fillStyle = g.strokeStyle; g.font = `${Math.max(4, w / 40)}px sans-serif`;
          g.fillText(String(j + 1), x + r, y - r);
        });
      },
    });
    const play = toolButton("播放", "播放或暂停校准预览", () => {
      ctx.setLocal({ picking: false, centerPicking: false }); player.toggle();
    });
    const original = toolButton("原图", "切换原图与居中结果", () => ctx.setLocal({ showSource: !ctx.local.showSource, picking: false, centerPicking: false }));
    const guides = toolButton("中心线", "蓝线为画布中心，黄色十字为采用的跟踪中心；第 1 点为居中基准", () => ctx.setLocal({ showGuides: !ctx.local.showGuides }));
    const cancel = toolButton("取消跟踪", "停止当前跟踪任务", () => ctx.local.trackingController?.abort());
    controls.append(toolButton("‹", "上一帧", () => { ctx.setLocal({ picking: false, centerPicking: false }); player.step(-1); }),
      play, toolButton("›", "下一帧", () => { ctx.setLocal({ picking: false, centerPicking: false }); player.step(1); }), label, original, guides, cancel);
    const legend = el("div", { class: "tracking-legend" }, "① 居中基准 · 绿：可用 · 青：验证恢复 · 橙：拟合排除 · 红：不可用");
    ctx.body.append(stage.el, controls, status, legend);
    const pick = toolButton("选点", "首个选点作为中心；其他点辅助估计旋转，系统也会自动补点", () => {
      if (!busy(ctx)) { player.pause(); player.seek(0); ctx.setLocal({ picking: !ctx.local.picking, centerPicking: false }); }
    });
    const track = toolButton("跟踪", "跟踪整段动画", () => startTracking(ctx));
    ctx.tools.append(pick, track);
    ctx.local.seekTrackingFrame = index => { ctx.setLocal({ picking: false, centerPicking: false }); player.pause(); player.seek(index); };
    ctx.local.pickSubjectCenter = index => {
      if (index < 0 || index >= (ctx.input("src")?.frames.length || 0)) { ctx.toast("帧号超出当前动画。"); return; }
      player.pause(); ctx.setLocal({ picking: false, centerPicking: true, showSource: true }); player.seek(index);
    };
    stage.canvas.addEventListener("pointerdown", event => {
      if ((!ctx.local.picking && !ctx.local.centerPicking) || event.button !== 0) return;
      event.stopPropagation(); event.preventDefault();
      const src = ctx.input("src"), p = stage.point(event);
      if (ctx.local.centerPicking) { markSubjectCenter(ctx, player.index, p); return; }
      if (busy(ctx)) return;
      if (!src || !readPixel(src.frames[0].canvas, p.x, p.y)) { ctx.toast("请在角色的不透明部分选点。"); return; }
      const fingerprint = ctx.result()?.view?.sourceFingerprint;
      const selectedOn = ctx.params().pointsFingerprint || ctx.params().tracking?.sourceFingerprint;
      const points = selectedOn && selectedOn !== fingerprint ? [] : ctx.params().points || [];
      if (points.length >= 16) { ctx.toast("最多选择 16 个点，建议选 3～5 个躯干参考点。"); return; }
      if (points.some(q => Math.hypot(q[0] - p.x, q[1] - p.y) < 1)) return;
      ctx.set({ points: [...points, [p.x, p.y]], pointsFingerprint: fingerprint, tracking: null });
    });
    return {
      render() {
        const picking = ctx.local.picking, src = ctx.input("src");
        pick.classList.toggle("active", !!picking);
        original.classList.toggle("active", !!ctx.local.showSource);
        guides.classList.toggle("active", !!ctx.local.showGuides);
        pick.disabled = busy(ctx);
        track.disabled = busy(ctx) || !src?.frames.length || !ctx.params().points?.length;
        cancel.hidden = !busy(ctx);
        stage.el.classList.toggle("painting", !!picking || !!ctx.local.centerPicking);
        const value = picking || ctx.local.centerPicking || ctx.local.showSource ? src : ctx.output("out") || src;
        player.setValue(value || null);
        if (picking) { if (player.playing) player.pause(); player.seek(0); }
        else player.redraw();
        describeFrame(player.index);
      },
      destroy() { ctx.local.trackingController?.abort(); player.destroy(); },
    };
  },

  inspector(ctx, f) {
    f.hint("首帧第 1 个选点定义居中基准，其他点辅助估计旋转和缩放。跟踪后把估计中心放到画布中心；轮廓框不参与定位。尚未跟踪时保留原图。");
    f.buttons(["开始跟踪", () => startTracking(ctx), { primary: true, sync: b => { b.disabled = busy(ctx); } }],
      ["清空选点", () => clearPoints(ctx), { sync: b => { b.disabled = busy(ctx); } }]);
    f.readout(() => {
      const a = ctx.result()?.view;
      return [["居中目标", a ? `${a.target.x}, ${a.target.y}` : "画布正中心"],
        ["参考点", String(ctx.params().points?.length || 0)],
        ["跟踪状态", ctx.local.trackingMessage || (a?.trackingUsable ? "复用已保存轨迹" : "等待跟踪")],
        ["自动辅助点", String(ctx.params().tracking?.supportPoints?.length || 0)],
        ["插值 / 保持", `${a?.fallbackFrames.length || 0} 帧`], ["空帧", String(a?.emptyFrames.length || 0)]];
    });
    f.status(() => ctx.result()?.info?.stale
      ? { text: "输入或选点已变化，旧轨迹已停用。请重新选点并跟踪；不会改用轮廓中心。", tone: "warn" } : null);
    f.status(() => {
      const a = ctx.result()?.view;
      if (a?.untrackedFrames.length) return { text: "请先在首帧选择人物中心并开始跟踪。当前没有可用轨迹，保留原图位置。", tone: "warn" };
      return a?.reviewFrames.length ? { text: `这些帧使用轨迹回退，请检查：${a.reviewFrames.map(i => i + 1).join("、")}`, tone: "warn" } : null;
    });
    f.status(() => ctx.result()?.view?.trackingUsable && !ctx.params().tracking?.model?.stabilizationVersion
      ? { text: "当前为旧轨迹。可直接用于跟踪居中；重新跟踪可启用自动辅助点与反向验证。", tone: "warn" } : null);
    const tracking = f.section("旋转跟踪设置", { collapsible: true });
    tracking.hint("在首帧先点人物中心，可再选几个分散的躯干点。系统自动增加附近辅助点，进行正向和反向验证。点落在人物身上并不代表它仍是同一处细节；红色预测点不会被直接采用。");
    tracking.number("最少可靠点", "minPoints", { min: 1, max: 16 });
    tracking.number("旋转拟合残差（像素）", "tolerance", { min: 0.1, max: 100, integer: false, step: 0.5 });
    const manual = f.section("标记人物中心");
    manual.hint("可选纠错：首帧标记定义随轨迹运动的中心，其他帧标记只修正对应帧。标记不改变跟踪点身份，同一素材重新跟踪会保留标记。");
    manual.number("帧号（从 1 开始）", "editFrame", { min: 1, max: 512 });
    manual.pair(s => s.number("原图中心 X", "editCenterX", { min: 0, max: 8192, integer: false, step: 0.5 }),
      s => s.number("原图中心 Y", "editCenterY", { min: 0, max: 8192, integer: false, step: 0.5 }));
    manual.readout(() => {
      const i = (ctx.params().editFrame || 1) - 1, a = ctx.result()?.view, center = a?.centers[i];
      const source = sourceLabel[a?.diagnostics[i]?.source];
      return center ? [["本帧采用中心", pointText(center)], ["定位来源", source || "分析中"]] : null;
    });
    manual.buttons(["查看此帧", () => ctx.local.seekTrackingFrame?.(ctx.params().editFrame - 1)],
      ["在原图标中心", () => ctx.local.pickSubjectCenter?.(ctx.params().editFrame - 1)],
      ["读取当前中心", () => {
        const center = ctx.result()?.view?.centers[(ctx.params().editFrame || 1) - 1];
        if (center) ctx.set({ editCenterX: center.x, editCenterY: center.y });
      }], ["应用中心坐标", () => {
        const p = ctx.params(); markSubjectCenter(ctx, p.editFrame - 1, { x: p.editCenterX, y: p.editCenterY });
      }], ["移除此帧标记", () => {
        const centers = { ...ctx.params().subjectCenters };
        delete centers[ctx.params().editFrame - 1]; ctx.set({ subjectCenters: centers });
      }]);
    f.hint(() => Object.keys(ctx.params().corrections || {}).length
      ? "旧版位移修正已停用。需要纠错时可标记人物中心。" : "蓝线为画布中心，黄色十字为采用的中心。失败区间按前后可靠轨迹插值，首尾丢失时保持最近可靠位置，并提示检查。");
    const strip = makeFilmstrip({ onClick: i => {
      ctx.local.seekTrackingFrame?.(i); ctx.set({ editFrame: i + 1 });
    } });
    let stripKey;
    f.section("逐帧检查").custom(strip.el, () => {
      const v = ctx.output("out"), a = ctx.result()?.view;
      if (!v || v.ver === stripKey) return;
      stripKey = v.ver;
      strip.set(v.frames.map((frame, i) => ({ src: frame.canvas,
        label: `${i + 1}${a?.reviewFrames.includes(i) ? " ⚠" : ""}`,
        title: `第 ${i + 1} 帧 · ${sourceLabel[a?.diagnostics[i]?.source] || "等待跟踪"}` })));
    });
  },
});
