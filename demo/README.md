# Demo media

`docs/media/` (GIF, MP4, screenshots) is produced by these scripts on a
**throwaway** DSH. They create sessions and shares; never run them against a
real DSH.

1. Start a throwaway DSH (e.g. in a container) with `dsh-share-room` installed,
   `/share` public in your auth gate, and an OpenAI-compatible provider whose
   `baseURL` points at `demo-llm.mjs` (a scripted model, no real AI):

   ```sh
   PORT=18990 node demo/demo-llm.mjs
   ```

2. Record (owner desktop + two phone guests; screenshots and WebM per window,
   plus `captions.json` with timings):

   ```sh
   BASE=http://localhost:18994 SHARE_ROOM_PASSWORD=<throwaway password> \
   PLAYWRIGHT_FROM=/path/to/node_modules/ OUT=demo-out node demo/record.mjs
   ```

3. Compose with ffmpeg: `hstack` the three WebMs, burn in the captions
   (`ass` filter, a CJK font such as WenQuanYi Zen Hei or Noto Sans CJK), then
   encode MP4 (`libx264`) and a GIF (`palettegen`/`paletteuse`).
