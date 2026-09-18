import { describe, it, expect } from "vitest";
import { collectBootAlerts, type AutodlReminders } from "../../src/services/autodl-reminders.js";

// 2026-09-18 实测根因:作品页 AutoDL 开机横幅(轮询 /api/autodl/reminders)从未接线
// 语音提醒——唯一的开机语音挂在 generate/video 的 eco 分支(实际发起生成才触发),
// 用户看到横幅时语音从未响过。修复:服务端守望进程按同一聚合结果驱动语音,
// 决策逻辑收敛到 collectBootAlerts(纯函数,可测)。

function base(): AutodlReminders {
  return {
    h3: { state: "offline", consoleUrl: "", neededBy: [], upcoming: [] },
    heygem: { state: "offline", consoleUrl: "", neededBy: [], upcoming: [] },
  };
}

describe("collectBootAlerts(开机语音提醒决策)", () => {
  it("H3 离线且有临近素材阶段的作品 → 产生语音提醒", () => {
    const r = base();
    r.h3.neededBy = [{ id: "w1", title: "作品甲", certainty: "confirmed" }];
    const alerts = collectBootAlerts(r);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toContain("h3");
    expect(alerts[0].key).toContain("w1");
    expect(alerts[0].text).toContain("开机");
    expect(alerts[0].text).toContain("作品甲");
  });

  it("实例在线(ready)时即使有需要 → 不提醒(无需开机)", () => {
    const r = base();
    r.h3.state = "ready";
    r.h3.neededBy = [{ id: "w1", title: "作品甲" }];
    expect(collectBootAlerts(r)).toHaveLength(0);
  });

  it("只有 upcoming 预告(未临近素材阶段)→ 不提醒(避免提前开机空烧 GPU)", () => {
    const r = base();
    r.h3.upcoming = [{ id: "w1", title: "作品甲", certainty: "confirmed" }];
    expect(collectBootAlerts(r)).toHaveLength(0);
  });

  it("数字人(heygem)离线且有待渲染作品 → 产生语音提醒", () => {
    const r = base();
    r.heygem.neededBy = [{ id: "w2", title: "数字人作品" }];
    const alerts = collectBootAlerts(r);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toContain("heygem");
  });

  it("H3 与数字人同时离线缺料 → 两条独立提醒(各自 key 去重)", () => {
    const r = base();
    r.h3.neededBy = [{ id: "w1", title: "甲" }];
    r.heygem.neededBy = [{ id: "w2", title: "乙" }];
    const alerts = collectBootAlerts(r);
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((a) => a.key)).size).toBe(2);
  });

  it("多个作品共用同一实例 → 聚合为一条提醒", () => {
    const r = base();
    r.h3.neededBy = [
      { id: "w1", title: "甲" },
      { id: "w2", title: "乙" },
    ];
    const alerts = collectBootAlerts(r);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("甲");
    expect(alerts[0].text).toContain("乙");
  });

  it("无任何需求 → 静默", () => {
    expect(collectBootAlerts(base())).toHaveLength(0);
  });
});
