import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";

/**
 * SSH 免密一键配置(设置页"推送公钥"按钮的后端)。
 *
 * 解决打包分发后的最大门槛:新机器上用户没有配过对 AutoDL 实例的免密登录,
 * 而 H3/HeyGem 隧道(BatchMode=yes)不允许交互输密码。
 *   - ensureLocalKeyPair(): 本机没有 ~/.ssh/id_ed25519 就用 ssh-keygen 生成
 *     (Windows 自带 OpenSSH 客户端;无口令,与隧道 BatchMode 兼容)
 *   - pushPublicKey(): 用 ssh2 密码认证登录实例,把本机公钥追加到
 *     ~/.ssh/authorized_keys(幂等:已存在则跳过)
 */

const KEY_PATH = join(homedir(), ".ssh", "id_ed25519");
const PUB_PATH = KEY_PATH + ".pub";

export async function ensureLocalKeyPair(): Promise<string> {
  if (!existsSync(PUB_PATH)) {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", KEY_PATH], {
        stdio: "ignore",
        windowsHide: true,
      });
      proc.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`ssh-keygen 退出码 ${code}:请确认系统已安装 OpenSSH 客户端`)),
      );
      proc.on("error", (err) => reject(new Error(`ssh-keygen 不可用:${err.message}`)));
    });
  }
  return (await readFile(PUB_PATH, "utf-8")).trim();
}

export interface PushKeyOpts {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** 推送公钥到实例。成功返回提示文本;失败抛错(认证失败/网络不通等) */
export async function pushPublicKey(opts: PushKeyOpts): Promise<string> {
  const pub = await ensureLocalKeyPair();

  return new Promise<string>((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error("连接超时(15 秒):请检查实例是否已开机、SSH 地址端口是否正确"));
    }, 15_000);

    conn
      .on("ready", () => {
        const cmd = [
          "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
          "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
          `grep -qF '${pub}' ~/.ssh/authorized_keys || echo '${pub}' >> ~/.ssh/authorized_keys`,
          "echo PUSH_OK",
        ].join(" && ");
        conn.exec(cmd, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(new Error(`远程命令执行失败:${err.message}`));
          }
          let out = "";
          stream.on("data", (d: Buffer) => (out += d.toString()));
          stream.on("close", () => {
            clearTimeout(timer);
            conn.end();
            if (out.includes("PUSH_OK")) resolve("公钥已写入实例,免密登录已生效");
            else reject(new Error(`远程命令输出异常:${out.slice(0, 200)}`));
          });
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        const msg = err.message.includes("authentication")
          ? "密码认证失败:请核对 AutoDL 控制台「快捷登录」中的密码"
          : `SSH 连接失败:${err.message}`;
        reject(new Error(msg));
      })
      .connect({
        host: opts.host,
        port: opts.port,
        username: opts.user,
        password: opts.password,
        readyTimeout: 12_000,
      });
  });
}
