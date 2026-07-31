import { loadConfig } from "../config.js";

const HOST = "https://api.autodl.com";

/** 开机后在实例上启动 HeyGem API（6006 端口 + Token）。Pro 实例无数据盘，日志写系统盘 */
export const HEYGEM_START_COMMAND =
  "mkdir -p /root/autodl-tmp && cd /root/HeyGem-Linux-Python-Hack && nohup bash start_api.sh > /root/heygem_api.log 2>&1 &";

export type AutoDlInstanceStatus = "running" | "shutdown" | "starting" | "stopping" | "unknown";

interface AutoDlResponse {
  code: string;
  msg?: string;
  data?: unknown;
}

async function autodlRequest(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const config = await loadConfig();
  const autodl = config.autodl;
  if (!autodl?.token) throw new Error("未配置 AutoDL 开发者 Token（autodl.token）");
  if (!autodl.instanceUuid) throw new Error("未配置 AutoDL 实例 ID（autodl.instanceUuid）");
  const res = await fetch(`${HOST}${path}`, {
    method: "POST",
    headers: { Authorization: autodl.token, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as AutoDlResponse;
  if (data.code !== "Success") {
    throw new Error(data.msg || `AutoDL API 错误: ${data.code}`);
  }
  return data.data;
}

export async function powerOnInstance(): Promise<void> {
  const config = await loadConfig();
  await autodlRequest("/api/v1/dev/instance/pro/power_on", {
    instance_uuid: config.autodl?.instanceUuid,
    payload: "gpu",
    start_command: HEYGEM_START_COMMAND,
  });
}

export async function powerOffInstance(): Promise<void> {
  const config = await loadConfig();
  await autodlRequest("/api/v1/dev/instance/pro/power_off", {
    instance_uuid: config.autodl?.instanceUuid,
  });
}

export async function getInstanceStatus(): Promise<AutoDlInstanceStatus> {
  const config = await loadConfig();
  const data = await autodlRequest("/api/v1/dev/instance/pro/detail", {
    instance_uuid: config.autodl?.instanceUuid,
  }) as { status?: string } | null;
  const raw = (data?.status ?? "").toLowerCase();
  if (raw === "running") return "running";
  if (raw === "shutdown" || raw === "stopped") return "shutdown";
  if (raw === "starting") return "starting";
  if (raw === "stopping") return "stopping";
  return "unknown";
}
