import assert from "node:assert/strict";
import test from "node:test";
import { discoverLocalProviders } from "./local-provider-discovery.js";

test("local provider probes never forward stored credentials", async () => {
  let requestOptions;
  const results = await discoverLocalProviders({
    candidates: [{ apiUrl: "http://127.0.0.1:4321/v1", hint: "Local test" }],
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "local-model" }] })
      };
    }
  });

  assert.equal(requestOptions.headers.authorization, undefined);
  assert.equal(requestOptions.headers.accept, "application/json");
  assert.equal(requestOptions.cache, "no-store");
  assert.deepEqual(results[0]?.models, ["local-model"]);
});

test("only a gateway that names itself Magpie is offered Transly's Magpie client key", async () => {
  const probe = (helloBody) => {
    const requests = [];
    return {
      requests,
      fetchImpl: async (url, options) => {
        requests.push({ url, authorization: options.headers.authorization });
        if (url.endsWith("/api/hello")) {
          return helloBody
            ? { ok: true, status: 200, json: async () => helloBody }
            : { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "claude/claude-sonnet-5-5" }] }) };
      }
    };
  };
  const candidates = [{ apiUrl: "http://127.0.0.1:3425/v1", hint: "Magpie", service: "magpie" }];

  const magpie = probe({ name: "magpie", version: "0.1.0" });
  const [confirmed] = await discoverLocalProviders({ candidates, fetchImpl: magpie.fetchImpl });
  assert.equal(confirmed.clientKey, "magpie-transly");
  assert.deepEqual(magpie.requests.map((request) => request.url).sort(), [
    "http://127.0.0.1:3425/api/hello",
    "http://127.0.0.1:3425/v1/models"
  ]);
  assert.equal(magpie.requests.every((request) => request.authorization === undefined), true);

  for (const helloBody of [{ name: "other-gateway" }, null]) {
    const other = probe(helloBody);
    const [unconfirmed] = await discoverLocalProviders({ candidates, fetchImpl: other.fetchImpl });
    assert.deepEqual(unconfirmed.models, ["claude/claude-sonnet-5-5"]);
    assert.equal(unconfirmed.clientKey, undefined);
  }
});
