
## deepseek（2026-08-16T15:31:19.563Z）

- ✅ 文本流式(deepseek-v4-flash)：end_turn，1199ms，输出「1+1=2。」，usage in=95/out=54/cacheHit=0
- ✅ 工具回合：get_weather({"city":"北京"})
- ❌ vision(deepseek-v4-vision)：LLM API 400: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text` at line 1 column 334","type":"invalid_request_erro

## kimi（2026-08-16T15:31:22.166Z）

- ❌ 文本流式(kimi-k2)：LLM API 401: {"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}
- ❌ 工具回合：LLM API 401: {"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}
- ❌ vision(moonshot-v1-32k-vision-preview)：LLM API 401: {"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}

## glm（2026-08-16T15:31:22.507Z）

- ⏭️ 文本流式/工具回合：跳过（glm 按约束仅用于视觉识别）
- ✅ vision(glm-4v)：「这张图是一个**纯色的粉色（或珊瑚色）矩形块**，画面中没有其他元素（如形状、文字、图案等），整体呈现为均匀的单一色彩填」

## kimi（2026-08-16T15:34:03.191Z）

- ✅ 文本流式(kimi-for-coding)：end_turn，1733ms，输出「1+1=2。」，usage in=23/out=36/cacheHit=n/a
- ✅ 工具回合：get_weather({"city":"北京"})
- ✅ vision(kimi-for-coding)：「这张图看起来是**全黑的**，没有可见的物体、文字或细节。

它可能是一个占位图、透明像素，或者图片没有正常显示。如果你」
