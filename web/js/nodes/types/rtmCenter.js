import { defineNode } from "../registry.js";
import { makeStage, makePlayer, makeFilmstrip, toolButton } from "../view.js";
import { api } from "../../core/api.js";
import { createCanvas, el } from "../../core/util.js";
import { sequenceFingerprint, sequenceSubjects, uploadSequence } from "../../tracking/frames.js";
import { runTrackingJob } from "../../tracking/client.js";
import { computeRtmAlignment, TORSO_JOINTS } from "../../imaging/rtmAlign.js";

const MODEL = "rtmpose-m_humanart_256x192";
const busy = ctx => !!ctx.local.rtmController;
const labels = { pose: "RTM 躯干估计", interpolated: "姿态缺失 · 插值 · 请检查", held: "姿态缺失 · 保持 · 请检查",
  unavailable: "等待 RTM 识别 · 保留原图", empty: "空帧" };
const matches = (p, fingerprint, src) => p?.sourceFingerprint === fingerprint && p?.model?.name === MODEL
  && p.width === src.w && p.height === src.h && p.keypoints?.length === src.frames.length
  && p.scores?.length === src.frames.length;

async function estimate(ctx) {
  if (busy(ctx)) return;
  const src = ctx.input("src"), projectId = ctx.store.projectId;
  if (!src?.frames.length) { ctx.toast("请先连接序列帧。"); return; }
  if (src.frames.length > 512 || src.w * src.h > 16 * 1024 * 1024) {
    ctx.toast("每组最多 512 帧，单帧最多 1600 万像素。"); return;
  }
  const controller = new AbortController();
  const update = text => ctx.setLocal({ rtmMessage: text });
  ctx.setLocal({ rtmController: controller, rtmError: null, showSource: false, rtmMessage: "检查 RTMPose 环境…" });
  try {
    const status = await api.rtmStatus();
    if (status.busy) throw new Error("另一个 RTM 定位任务正在运行，请稍后重试。");
    if (!status.ready) throw new Error(status.error || "RTMPose 尚未准备好，请先运行 npm run rtm:setup。");
    const sourceFingerprint = await sequenceFingerprint(src);
    const assetIds = await uploadSequence(src, projectId, api, controller.signal,
      (done, total) => update(`准备图片 ${done}/${total}`));
    const result = await runTrackingJob({ startTracking: api.startRtm, trackingJob: api.rtmJob, cancelTracking: api.cancelRtm },
      projectId, { assetIds, width: src.w, height: src.h }, { signal: controller.signal,
        onProgress: job => update(`RTM 识别 ${job.done}/${job.total}`) });
    if (!ctx.card() || controller.signal.aborted || ctx.store.projectId !== projectId) return;
    const current = ctx.input("src"), currentFingerprint = current && await sequenceFingerprint(current);
    if (!ctx.card() || controller.signal.aborted || ctx.store.projectId !== projectId) return;
    if (!current || currentFingerprint !== sourceFingerprint) { update("输入已变化，请重新识别。"); return; }
    ctx.set({ pose: { ...result, sourceFingerprint, assetIds } });
    update(`RTM 识别完成 · ${src.frames.length} 帧`);
  } catch (error) {
    const text = error.name === "AbortError" ? "RTM 识别已取消" : error.message;
    ctx.setLocal({ rtmError: error.name === "AbortError" ? null : text });
    update(text);
    if (error.name !== "AbortError") ctx.toast(text, "error");
  } finally {
    if (ctx.local.rtmController === controller) ctx.setLocal({ rtmController: null });
  }
}

defineNode({
  type: "rtmCenter", title: "主体居中RTM", category: "处理", icon: "◎",
  help: "独立使用 RTMPose Human-Art 识别肩与髋，在躯干轴上推算中心并逐帧居中。无需 TAPNext 选点；姿态不可靠时插值或保持，并提示检查。",
  inputs: [{ name: "src", label: "序列帧", accepts: ["frames"] }],
  outputs: [{ name: "out", label: "序列帧", kind: "frames" }],
  size: { w: 340, h: 350 },
  defaults: () => ({ pose: null, threshold: 0.25, centerRatio: 0.5, inspectFrame: 1 }),

  async evaluate(p, { src }) {
    if (!src.frames.length) return { outputs: { out: { ...src } }, info: { text: "空动画" } };
    const sourceFingerprint = await sequenceFingerprint(src), poseUsable = matches(p.pose, sourceFingerprint, src);
    const a = computeRtmAlignment(poseUsable ? p.pose : null, { width: src.w, height: src.h,
      subjects: sequenceSubjects(src), threshold: p.threshold, centerRatio: p.centerRatio,
      durations: src.frames.map(frame => frame.duration || 1000 / Math.max(1, src.fps || 12)) });
    const frames = src.frames.map((frame, i) => {
      const canvas = createCanvas(a.outW, a.outH), g = canvas.getContext("2d");
      g.imageSmoothingEnabled = false;
      g.drawImage(frame.canvas, a.offsets[i].dx, a.offsets[i].dy);
      return { ...frame, canvas };
    });
    const direct = a.diagnostics.filter(d => d.source === "pose").length, fallback = a.fallbackFrames.length;
    return { outputs: { out: { ...src, w: a.outW, h: a.outH, frames } },
      info: { text: `${frames.length} 帧 · ${a.outW}×${a.outH} · ${poseUsable ? `RTM 估计 ${direct} 帧${fallback ? ` · 回退 ${fallback} 帧` : ""}` : "等待 RTM 识别"}`,
        stale: !!p.pose && !poseUsable, direct, fallback },
      view: { ...a, sourceFingerprint, poseUsable } };
  },

  mount(ctx) {
    ctx.local.showSkeleton = true; ctx.local.showGuides = true;
    const stage = makeStage({ fit: "integer" }), status = el("div", { class: "tracking-status", role: "status" });
    const controls = el("div", { class: "tracking-controls" }), count = el("span", { class: "mono" });
    const describe = i => {
      if (busy(ctx)) { status.textContent = ctx.local.rtmMessage; return; }
      const d = ctx.result()?.view?.diagnostics[i];
      status.textContent = ctx.local.rtmError || `第 ${i + 1} 帧 · ${labels[d?.source] || "等待识别"}${d?.needsReview && d.reason ? ` · ${d.reason}` : ""}`;
    };
    const player = makePlayer(stage, { autoplay: false, fps: () => ctx.input("src")?.fps || 12,
      emptyText: "连接序列帧，点击识别", onFrame(i, n, playing) {
        count.textContent = `${i + 1}/${n}`; play.textContent = playing ? "暂停" : "播放"; describe(i);
      },
      overlay(g, w, h, i) {
        const a = ctx.result()?.view, p = ctx.params();
        if (!a) return;
        const o = ctx.local.showSource ? { dx: 0, dy: 0 } : a.offsets[i];
        if (!o) return;
        g.lineWidth = Math.max(0.5, w / 500);
        if (ctx.local.showGuides) {
          g.strokeStyle = "rgba(80,220,255,0.65)";
          g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
          const c = a.centers[i];
          if (c) {
            const x = c.x + o.dx, y = c.y + o.dy, r = Math.max(2, w / 90);
            g.strokeStyle = "#ffd45e";
            g.beginPath(); g.moveTo(x - r, y); g.lineTo(x + r, y); g.moveTo(x, y - r); g.lineTo(x, y + r); g.stroke();
          }
        }
        if (!a.poseUsable || !ctx.local.showSkeleton) return;
        // Parameters update before the asynchronous output evaluation finishes.
        const points = p.pose?.keypoints?.[i], scores = p.pose?.scores?.[i];
        if (!points || !scores) return;
        const finite = j => Array.isArray(points[j]) && points[j].every(Number.isFinite);
        const accepted = j => finite(j) && scores[j] >= p.threshold && (!p.pose.foreground?.[i] || p.pose.foreground[i][j]);
        for (const [left, right] of [[5, 6], [11, 12], [5, 11], [6, 12]]) {
          if (!finite(left) || !finite(right)) continue;
          g.strokeStyle = accepted(left) && accepted(right) ? "#50f0b0" : "#ff6464";
          g.beginPath(); g.moveTo(points[left][0] + o.dx, points[left][1] + o.dy);
          g.lineTo(points[right][0] + o.dx, points[right][1] + o.dy); g.stroke();
        }
        for (const j of TORSO_JOINTS) {
          if (!finite(j)) continue;
          g.fillStyle = accepted(j) ? "#50f0b0" : "#ff6464";
          g.beginPath(); g.arc(points[j][0] + o.dx, points[j][1] + o.dy, Math.max(1, w / 180), 0, Math.PI * 2); g.fill();
        }
      },
    });
    const play = toolButton("播放", "播放或暂停 RTM 居中预览", () => player.toggle());
    const original = toolButton("原图", "对照原图中的肩髋位置与居中结果", () => ctx.setLocal({ showSource: !ctx.local.showSource }));
    const skeleton = toolButton("骨架", "显示左右肩、左右髋及躯干连线", () => ctx.setLocal({ showSkeleton: !ctx.local.showSkeleton }));
    const guides = toolButton("中心线", "蓝线为画布中心，黄色十字为采用的中心", () => ctx.setLocal({ showGuides: !ctx.local.showGuides }));
    const start = toolButton("识别", "使用 RTMPose 独立识别每帧肩髋，无需选点", () => estimate(ctx));
    const cancel = toolButton("取消识别", "停止 RTM 定位任务", () => ctx.local.rtmController?.abort());
    ctx.tools.append(start);
    controls.append(toolButton("‹", "上一帧", () => player.step(-1)), play,
      toolButton("›", "下一帧", () => player.step(1)), count, original, skeleton, guides, cancel);
    ctx.body.append(stage.el, controls, status,
      el("div", { class: "tracking-legend" }, "肩髋骨架 · 绿点：达到阈值 · 红点：未通过 · 黄十字：采用中心 · ⚠：回退"));
    ctx.local.seekRtmFrame = i => { player.pause(); player.seek(i); };
    return { render() {
      start.disabled = busy(ctx) || !ctx.input("src")?.frames.length;
      cancel.hidden = !busy(ctx);
      original.classList.toggle("active", !!ctx.local.showSource);
      skeleton.classList.toggle("active", !!ctx.local.showSkeleton);
      guides.classList.toggle("active", !!ctx.local.showGuides);
      player.setValue((ctx.local.showSource ? ctx.input("src") : ctx.output("out")) || ctx.input("src") || null);
      player.redraw(); describe(player.index);
    }, destroy() { ctx.local.rtmController?.abort(); player.destroy(); } };
  },

  inspector(ctx, f) {
    f.hint("独立使用 RTMPose Human-Art 定位肩与髋，无需 TAPNext 或逐帧选点。先点击「开始识别」，再用骨架和原图检查结果。");
    f.buttons(["开始识别", () => estimate(ctx), { primary: true, sync: b => { b.disabled = busy(ctx) || !ctx.input("src")?.frames.length; } }],
      ["清空识别结果", () => { ctx.set({ pose: null }); ctx.setLocal({ rtmError: null, rtmMessage: "" }); }, { sync: b => { b.disabled = busy(ctx); } }]);
    f.slider("中心位置（肩→髋）", "centerRatio", { min: 0, max: 1, step: 0.05, fallback: 0.5 });
    f.hint("0 为双肩中点，1 为双髋中点，0.5 为躯干中点。这个位置随身体方向变化，不使用人物外接框中心。");
    f.slider("关节分数阈值", "threshold", { min: 0.05, max: 0.8, step: 0.01, fallback: 0.25 });
    f.hint("分数是模型响应值，不是识别正确率。修改阈值和中心位置会直接复用已保存的姿态。");
    f.readout(() => {
      const a = ctx.result()?.view;
      return [["模型", "RTMPose-m · Human-Art · CPU"], ["状态", ctx.local.rtmMessage || (a?.poseUsable ? "复用已保存姿态" : "等待识别")],
        ["RTM 估计", `${ctx.result()?.info?.direct || 0} 帧`], ["插值 / 保持", `${a?.fallbackFrames.length || 0} 帧`]];
    });
    f.status(() => ctx.result()?.info?.stale ? { text: "输入已变化，旧姿态已停用，请重新识别。", tone: "warn" } : null);
    f.status(() => {
      const a = ctx.result()?.view;
      if (a?.unavailableFrames.length) return { text: "没有可用的肩髋定位，当前保留原图位置。请识别或检查关节分数。", tone: "warn" };
      return a?.reviewFrames.length ? { text: `这些帧的肩髋定位未通过，使用插值或保持，请检查：${a.reviewFrames.map(i => i + 1).join("、")}`, tone: "warn" } : null;
    });
    const inspect = f.section("逐帧检查");
    inspect.number("查看帧号（从 1 开始）", "inspectFrame", { min: 1, max: 512 });
    inspect.buttons(["查看此帧", () => ctx.local.seekRtmFrame?.((ctx.params().inspectFrame || 1) - 1)]);
    inspect.readout(() => {
      const i = (ctx.params().inspectFrame || 1) - 1, a = ctx.result()?.view, c = a?.centers[i], d = a?.diagnostics[i];
      return [["定位来源", labels[d?.source] || "等待识别"], ["肩髋最低分", (d?.confidence || 0).toFixed(3)],
        ["采用中心", c ? `${c.x.toFixed(2)}, ${c.y.toFixed(2)}` : "无"], ["原因", d?.reason || "—"]];
    });
    const strip = makeFilmstrip({ onClick: i => { ctx.local.seekRtmFrame?.(i); ctx.set({ inspectFrame: i + 1 }); } });
    let version;
    inspect.custom(strip.el, () => {
      const v = ctx.output("out"), a = ctx.result()?.view;
      if (!v || v.ver === version) return;
      version = v.ver;
      strip.set(v.frames.map((frame, i) => ({ src: frame.canvas,
        label: `${i + 1}${a?.reviewFrames.includes(i) ? " ⚠" : ""}`,
        title: `第 ${i + 1} 帧 · ${labels[a?.diagnostics[i]?.source] || "等待识别"}` })));
    });
  },
});
