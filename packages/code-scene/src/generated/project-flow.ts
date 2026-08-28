
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("flow-steps")({"title":"融资平台退出三条硬标准","steps":[{"title":"隐性债务清零","desc":"名单内隐性债务全部化解归零"},{"title":"剥离政府融资职能","desc":"不再承担政府投融资功能"},{"title":"市场化转型或注销","desc":"转型为市场化主体或合规退出"}],"theme":"finance_dark"});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1080, 1920), range: [0, 8] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
