import assert from "node:assert/strict";
import { test } from "node:test";

import { MASK, SecretMask } from "../mask.js";

test("a registered value is replaced in output", () => {
  const mask = new SecretMask();
  mask.register("hunter2");

  assert.equal(mask.apply("typed hunter2 into the field"), `typed ${MASK} into the field`);
});

test("the URL-encoded form of a registered value is replaced", () => {
  const mask = new SecretMask();
  mask.register("p@ss word/1");

  assert.equal(mask.apply("GET /login?p=p%40ss%20word%2F1"), `GET /login?p=${MASK}`);
  assert.equal(mask.apply("body p=p%40ss+word%2F1"), `body p=${MASK}`);
});

test("several registered values are replaced in one line", () => {
  const mask = new SecretMask();
  mask.register("alice");
  mask.register("123456");

  assert.equal(mask.apply("user alice code 123456 again alice"), `user ${MASK} code ${MASK} again ${MASK}`);
});

test("a value that contains another registered value is replaced whole", () => {
  const mask = new SecretMask();
  mask.register("abc");
  mask.register("abcdef");

  assert.equal(mask.apply("value abcdef"), `value ${MASK}`);
});

test("an empty value is not registered", () => {
  const mask = new SecretMask();
  mask.register("");

  assert.equal(mask.apply("nothing to hide"), "nothing to hide");
});
