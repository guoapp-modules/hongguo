const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const videoId = "7700000000000000001";
const state = { version: 1, deviceId: "123", installId: "456", registered: true, helperDeviceId: "789", helperInstallId: "987", helperRegistered: true, feeds: {} };
const model = { video_duration: 80.5, video_list: [
  { main_url: "https://media.example.invalid/unsupported.mp4", video_meta: { codec_type: "bytevc2", definition: "1080p" } },
  { main_url: "https://media.example.invalid/main.mp4", backup_url: "https://media.example.invalid/backup.mp4", video_meta: { codec_type: "bytevc1", definition: "1080p" } },
] };

function load(response) {
  const cache = new Map();
  const requests = [];
  const host = {
    source: "hongguo",
    utf8Encode: (text) => Uint8Array.from(Buffer.from(text)),
    utf8Decode: (value) => Buffer.from(value).toString("utf8"),
    hexEncode: (value) => Buffer.from(value).toString("hex"),
    hexDecode: (value) => Uint8Array.from(Buffer.from(value, "hex")),
    base64Encode: (value) => Buffer.from(value).toString("base64"),
    base64Decode: (value) => {
      const raw = Buffer.from(value, "base64");
      if (raw.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) throw new Error("Invalid Base64");
      return Uint8Array.from(raw);
    },
    md5: (value) => Uint8Array.from(crypto.createHash("md5").update(Buffer.from(value)).digest()),
    randomBytes: (size) => Uint8Array.from(crypto.randomBytes(size)),
    aesCbcEncrypt: (key, iv, value) => {
      const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
      cipher.setAutoPadding(false);
      return Uint8Array.from(Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]));
    },
    parseUrl: (value) => {
      const url = new URL(value);
      return { scheme: url.protocol.slice(0, -1), hostname: url.hostname, userInfo: !!(url.username || url.password) };
    },
    preserveIntegers: (text) => text,
    cacheGet: (key) => cache.get(key) ?? null,
    cacheSet: (key, value) => cache.set(key, value),
    exclusive: (fn) => fn(),
    retries: () => 1,
    reserve: () => 1,
    fetch: (request) => {
      requests.push(request);
      const answer = typeof response === "function" ? response(request) : response;
      if (answer && typeof answer.status === "number" && "body" in answer) return answer;
      return { status: 200, body: JSON.stringify(answer), headers: {} };
    },
    fetchText: () => { throw new Error("Offline test: webpage fallback"); },
  };
  const context = vm.createContext({ host, module: { exports: {} } });
  vm.runInContext(source + "\nmodule.exports.test = { fetchAppMedia, fetchPlayerMedia, appRequest, paths, webMedia, webPlayback, webDesktopUserAgent, resolveVideoMedia, cencScheme };", context);
  context.module.exports.restoreCatalogState(state);
  return { api: context.module.exports, requests, context, host };
}

for (const nested of [false, true]) {
  test("playback uses v5 and the exact episode in " + (nested ? "1004" : "flat") + " responses", () => {
    const entries = { [videoId]: { video_model: JSON.stringify(model) }, "7700000000000000002": { video_model: {} } };
    const { api, requests } = load({ code: 0, data: nested ? { "1004": entries } : entries });
    const media = api.test.fetchPlayerMedia(videoId, false);
    assert.equal(media.url, "https://media.example.invalid/main.mp4");
    assert.equal(media.quality, 1080);
    assert.equal(media.durationMs, 80500);
    assert.equal(media.variants.length, 2);
    assert.equal(requests.length, 1);
    const request = requests[0];
    const url = new URL(request.url);
    assert.equal(url.hostname, "api5-normal-sinfonlinea.fqnovel.com");
    assert.equal(url.pathname, "/novel/player/multi_video_model/player/v1");
    assert.equal(url.searchParams.get("device_id"), state.deviceId);
    assert.equal(url.searchParams.get("iid"), state.installId);
    assert.equal(url.searchParams.has("ts"), false);
    const payload = JSON.parse(request.body);
    assert.deepEqual(payload.mixed_video_id_map, { "1004": [videoId] });
    assert.equal(payload.dr_scene, "player");
    assert.equal(payload.biz_param.video_platform, 1024);
    assert.equal(request.headers["X-Gorgon"], undefined);
    assert.equal(request.headers["X-Argus"], undefined);
    assert(request.headers["X-Medusa"] && request.headers["X-Helios"]);
    assert.equal(request.headers["X-SS-STUB"], crypto.createHash("md5").update(request.body).digest("hex").toUpperCase());
  });
}

test("playback prefers the signed video tab request", () => {
  const { api, requests } = load({ code: 0, data: { video_model_data: { [videoId]: { video_model: JSON.stringify(model) } } } });
  const media = api.test.fetchAppMedia(videoId, false);
  assert.equal(media.url, "https://media.example.invalid/main.mp4");
  assert.equal(media.variants.length, 2);
  assert.equal(requests.length, 1);
  const request = requests[0];
  const url = new URL(request.url);
  assert.equal(request.method, "GET");
  assert.equal(url.hostname, "api5-normal-sinfonlineb.fqnovel.com");
  assert.equal(url.pathname, "/reading/bookapi/video_tab/multi_video_model/v1/");
  assert.equal(url.searchParams.get("video_id"), videoId);
  assert.equal(url.searchParams.get("device_id"), state.deviceId);
  assert.equal(request.headers["X-Gorgon"], undefined);
  assert.equal(request.headers["X-SS-STUB"], undefined);
  assert(request.headers["X-Medusa"] && request.headers["X-Helios"]);
});

test("video tab without the episode falls back to the player request", () => {
  const { api, requests } = load((request) => request.url.includes("/video_tab/")
    ? { code: 0, data: { video_model_data: { "7700000000000000002": { video_model: model } } } }
    : { code: 0, data: { [videoId]: { video_model: model } } });
  const media = api.test.fetchAppMedia(videoId, false);
  assert.equal(media.url, "https://media.example.invalid/main.mp4");
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1].url).pathname, "/novel/player/multi_video_model/player/v1");
});

test("missing requested episode cannot use another episode", () => {
  const { api, requests } = load({ code: 0, data: { "7700000000000000002": { video_model: model } } });
  assert.throws(() => api.test.fetchPlayerMedia(videoId, false), /所请求的分集/);
  assert.equal(requests.length, 1);
});

test("malformed and rejected models fail explicitly", () => {
  for (const encoded of ["broken", "[]", "42"]) {
    const { api } = load({ code: 0, data: { [videoId]: { video_model: encoded } } });
    assert.throws(() => api.test.fetchPlayerMedia(videoId, false), /格式异常/);
  }
  const { api } = load({ code: 403, data: { [videoId]: { video_model: model } } });
  assert.throws(() => api.test.fetchPlayerMedia(videoId, false), /403/);
});

test("catalog and detail keep the previous signing and endpoint", () => {
  const { api, requests } = load({ code: 0, data: {} });
  api.test.appRequest("POST", api.test.paths.videoDetail, null, { series_id: "7700000000000000000" });
  assert.equal(new URL(requests[0].url).hostname, "api5-normal-sinfonlineb.fqnovel.com");
  assert(requests[0].headers["X-Gorgon"] && requests[0].headers["X-Argus"] && requests[0].headers["X-Ladon"]);
  assert.equal(requests[0].headers["X-Medusa"], undefined);
});

test("web playback resolves the protected fallback address", () => {
  const mainUrl = "https://v11-hgweb.qznovelvod.com/obj/x?mime_type=video_mp4";
  const { api, requests } = load({
    status: 200,
    body: JSON.stringify({ main_url: mainUrl, url_expire: 1795171132, base_resp: { StatusCode: 0, StatusMessage: "" } }),
    headers: {},
  });
  const media = api.test.webMedia("7700000000000000000", videoId);
  assert.equal(media.url, mainUrl);
  assert.equal(media.referer, "https://hongguoduanju.com/");
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, "POST");
  const url = new URL(request.url);
  assert.equal(url.hostname, "hongguoduanju.com");
  assert.equal(url.pathname, "/api/video/protected/fallback-play-info");
  assert.equal(url.searchParams.get("aid"), "8662");
  assert.deepEqual(JSON.parse(request.body), { item_id: videoId });
  assert.equal(request.headers["User-Agent"], api.test.webDesktopUserAgent);
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers["X-Xs-From-Web"], "1");
  assert.equal(request.headers.Referer, "https://hongguoduanju.com/");
});

test("web playback explains the five episode guest limit", () => {
  const { api, requests } = load({ status: 403, body: JSON.stringify({ error: "public_fallback_unavailable" }), headers: {} });
  assert.throws(() => api.test.webMedia("7700000000000000000", videoId), /前 5 集/);
  assert.equal(requests.length, 1);
});

test("web playback reports a rejected episode without retrying", () => {
  const { api, requests } = load({ status: 400, body: JSON.stringify({ error: "public_fallback_unavailable" }), headers: {} });
  assert.throws(() => api.test.webMedia("7700000000000000000", videoId), /没有为该集开放地址/);
  assert.equal(requests.length, 1);
});

test("web playback falls through to the protected stream and reports encryption", () => {
  const { api, requests } = load((request) => {
    if (request.url.includes("fallback-play-info")) return { status: 500, body: "", headers: {} };
    return {
      status: 200,
      body: JSON.stringify({ play_info: { main_url: "https://v11-hgweb.qznovelvod.com/dash", kid: "6ae6eca9f8818b2038da6ddb0002ebeb", format: "dash" }, base_resp: { StatusCode: 0 } }),
      headers: {},
    };
  });
  assert.throws(() => api.test.webMedia("7700000000000000000", videoId), /加密的 720p/);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body), { item_id: videoId, series_id: "7700000000000000000" });
});

test("locked webpage episodes fail through the app api and stay locked", () => {
  const { api, requests } = load((request) => request.url.includes("fallback-play-info")
    ? { status: 403, body: JSON.stringify({ error: "public_fallback_unavailable" }), headers: {} }
    : { status: 200, body: "", headers: {} });
  const task = { dramaId: "hongguo:7700000000000000000", chapter: { videoUrl: api.test.cencScheme + videoId } };
  assert.throws(() => api.test.resolveVideoMedia(task), /前 5 集/);
  assert.equal(requests.filter((request) => request.url.includes("hongguoduanju.com/api/")).length, 1);
  const before = requests.length;
  assert.throws(() => api.test.resolveVideoMedia(task), /暂时不再尝试网页取流/);
  assert.equal(requests.filter((request) => request.url.includes("hongguoduanju.com/api/")).length, 1);
  assert(requests.length > before);
});

test("v5 digest and carrier match independent synthetic vectors", () => {
  const { context } = load({});
  vm.runInContext("module.exports.vectors = { playbackV5Hash, playbackV5Carrier, signPlaybackV5, playbackV5IV, sm3 };", context);
  const api = context.module.exports.vectors;
  const decode = (text) => Buffer.from(text, "hex");
  const hashes = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "signing-v5-f13.json"), "utf8"));
  assert.equal(hashes.length, 32);
  for (const row of hashes) {
    const result = Buffer.from(api.playbackV5Hash(decode(row.query), decode(row.body), row.ts));
    assert.equal(result.length, 20);
    assert.equal(result.subarray(0, 16).toString("hex"), row.digest);
    assert.equal(result[16] & 0x24, 0x24);
  }
  const carriers = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "signing-v5-carrier.json"), "utf8"));
  assert.equal(carriers.length, 4);
  for (const row of carriers) {
    assert.equal(Buffer.from(api.playbackV5Carrier(decode(row.key), decode(row.iv), decode(row.source), row.ts)).toString("hex"), row.encrypted);
  }
  const values = { aid: "8662", device_id: "123", iid: "456", cdid: "synthetic", version_name: "7.4.3.32", channel: "vivo_8662_64", os_version: "12", device_type: "PGT-AN10" };
  const before = JSON.stringify(values);
  for (let ts = 1800000000; ts < 1800000032; ts++) {
    const body = Buffer.from('{"fixture":true}');
    const signed = api.signPlaybackV5("https://example.invalid/model", values, body, ts * 1000);
    const url = new URL(signed.url);
    const queryHash = crypto.createHash("sm3").update(url.search.slice(1)).digest();
    const bodyHash = crypto.createHash("md5").update(body).digest();
    assert.equal(api.playbackV5IV(queryHash, bodyHash, ts) & 15, 12);
    assert.equal(signed.headers["X-Khronos"], String(ts));
    assert.equal(signed.headers["X-SS-STUB"], bodyHash.toString("hex").toUpperCase());
    assert.equal(url.searchParams.has("ts"), false);
    for (const [key, value] of Object.entries(values)) assert.equal(url.searchParams.get(key), value);
  }
  assert.equal(JSON.stringify(values), before);
});
