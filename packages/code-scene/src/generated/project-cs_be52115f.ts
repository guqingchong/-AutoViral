
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("bar-compare")({"title":"��Ͷ���ʳɱ��ֻ�","bars":[{"label":"����ƽ̨","value":4},{"label":"������ƽ̨","value":7}],"unit":"%","highlightIndex":1,"source":"��������"});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1080, 1920), range: [0, 6] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
