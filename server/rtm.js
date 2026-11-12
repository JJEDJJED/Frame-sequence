import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrackingService, TrackingWorker } from "./tracking.js";
import { httpError } from "./projects.js";

function validateRtm({ assetIds, width, height }) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
    || width * height > 16 * 1024 * 1024) throw httpError(400, "画布尺寸无效");
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 512
    || assetIds.some(id => typeof id !== "string" || !id)) throw httpError(400, "请选择 1～512 帧");
}

export class RtmService extends TrackingService {
  constructor(workspace, { worker } = {}) {
    super(workspace, { worker: worker || new TrackingWorker({ setupCommand: "rtm:setup", script: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), "../python/rtm_worker.py") }),
    validateRequest: validateRtm, operation: "estimate", label: "RTM 定位" });
  }
}
