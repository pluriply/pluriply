import { test } from "node:test";
import assert from "node:assert/strict";
import { shortId, channelCode, taskId, entryId } from "../../src/shared/ids.js";

test("shortId returns lowercase alphanumeric of requested length", () => {
  const id = shortId(8);
  assert.equal(id.length, 8);
  assert.match(id, /^[a-z0-9]+$/);
  assert.notEqual(shortId(8), shortId(8));
});

test("channelCode has plp-xxxx-xxxx shape", () => {
  assert.match(channelCode(), /^plp-[a-z0-9]{4}-[a-z0-9]{4}$/);
});

test("taskId and entryId are prefixed", () => {
  assert.match(taskId(), /^task_[a-z0-9]{10}$/);
  assert.match(entryId(), /^ctx_[a-z0-9]{10}$/);
});
