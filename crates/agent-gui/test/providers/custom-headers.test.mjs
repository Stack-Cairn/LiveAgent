import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const customHeaders = loader.loadModule("@liveagent/ui/lib/providers/customHeaders.ts");

function errorHasCode(code) {
  return (error) => error?.code === code;
}

test("parses JSON objects and arrays", () => {
  assert.deepEqual(
    customHeaders.parseCustomHeadersImport(
      '{"X-Title":"LiveAgent","X-Environment":"production"}',
    ),
    {
      headers: [
        { key: "X-Title", value: "LiveAgent" },
        { key: "X-Environment", value: "production" },
      ],
      issues: [],
    },
  );

  assert.deepEqual(
    customHeaders.parseCustomHeadersImport(
      '[{"key":"X-Title","value":"LiveAgent"}]',
    ),
    {
      headers: [{ key: "X-Title", value: "LiveAgent" }],
      issues: [],
    },
  );
});

test("converts JSON number and boolean values and skips nested values", () => {
  const result = customHeaders.parseCustomHeadersImport(
    JSON.stringify({
      "X-String": "literal",
      "X-Number": 42,
      "X-Boolean": false,
      "X-Null": null,
      "X-Object": { nested: true },
      "X-Array": ["nested"],
    }),
  );

  assert.deepEqual(result.headers, [
    { key: "X-String", value: "literal" },
    { key: "X-Number", value: "42" },
    { key: "X-Boolean", value: "false" },
  ]);
  assert.deepEqual(
    result.issues.map(({ key, reason }) => ({ key, reason })),
    [
      { key: "X-Null", reason: "unsupported-value" },
      { key: "X-Object", reason: "unsupported-value" },
      { key: "X-Array", reason: "unsupported-value" },
    ],
  );
  assert.ok(result.issues.every((issue) => !("value" in issue)));
});

test("extracts quoted cURL headers across Bash, PowerShell, and CMD continuations", () => {
  const bash = [
    'curl "https://example.test" \\',
    '  -H "X-Double: one" \\',
    "  --header 'X-Single: two'",
  ].join("\n");
  const powershell = [
    'curl "https://example.test" ' + String.fromCharCode(96),
    '  --header "X-PowerShell: three"',
  ].join("\n");
  const cmd = [
    'curl "https://example.test" ^',
    '  -H "X-Cmd: four"',
  ].join("\r\n");

  assert.deepEqual(customHeaders.parseCustomHeadersImport(bash).headers, [
    { key: "X-Double", value: "one" },
    { key: "X-Single", value: "two" },
  ]);
  assert.deepEqual(customHeaders.parseCustomHeadersImport(powershell).headers, [
    { key: "X-PowerShell", value: "three" },
  ]);
  assert.deepEqual(customHeaders.parseCustomHeadersImport(cmd).headers, [
    { key: "X-Cmd", value: "four" },
  ]);
});

test("supports --header=value, preserves value colons, and ignores non-header cURL options", () => {
  const result = customHeaders.parseCustomHeadersImport(
    'curl "https://example.test" -X POST --data "secret-body" --cookie "secret-cookie" ' +
      '--header="X-Endpoint: https://api.example.test:8443/v1"',
  );

  assert.deepEqual(result, {
    headers: [{ key: "X-Endpoint", value: "https://api.example.test:8443/v1" }],
    issues: [],
  });
});

test("uses the last case-insensitive duplicate from imported content", () => {
  const result = customHeaders.parseCustomHeadersImport(
    '[{"key":"X-Title","value":"first"},{"key":"x-title","value":"last"}]',
  );

  assert.deepEqual(result.headers, [{ key: "x-title", value: "last" }]);
});

test("overwrites existing names in place and appends new headers without mutating inputs", () => {
  const current = [
    { key: "X-First", value: "one" },
    { key: "X-Title", value: "old" },
    { key: "X-Last", value: "three" },
    { key: "x-title", value: "duplicate" },
  ];
  const imported = [
    { key: "x-TITLE", value: "new" },
    { key: "X-New", value: "four" },
  ];

  const merged = customHeaders.mergeImportedCustomHeaders(current, imported);

  assert.deepEqual(merged, {
    headers: [
      { key: "X-First", value: "one" },
      { key: "x-TITLE", value: "new" },
      { key: "X-Last", value: "three" },
      { key: "X-New", value: "four" },
    ],
    importedCount: 2,
    overwrittenCount: 1,
  });
  assert.deepEqual(current, [
    { key: "X-First", value: "one" },
    { key: "X-Title", value: "old" },
    { key: "X-Last", value: "three" },
    { key: "x-title", value: "duplicate" },
  ]);
  assert.deepEqual(imported, [
    { key: "x-TITLE", value: "new" },
    { key: "X-New", value: "four" },
  ]);
});

test("skips protected names, invalid names, and CR/LF values without exposing values", () => {
  const result = customHeaders.parseCustomHeadersImport(
    JSON.stringify({
      Authorization: "secret-auth",
      "x-api-key": "secret-api",
      "x-goog-api-key": "secret-google",
      "anthropic-beta": "secret-beta",
      Host: "secret-host",
      "Content-Length": 10,
      "Bad Header": "secret-invalid",
      "X-Line": "secret\r\ninjected",
      "X-Okay": "kept",
    }),
  );

  assert.deepEqual(result.headers, [{ key: "X-Okay", value: "kept" }]);
  assert.deepEqual(
    result.issues.map(({ key, reason }) => ({ key, reason })),
    [
      { key: "Authorization", reason: "reserved" },
      { key: "x-api-key", reason: "reserved" },
      { key: "x-goog-api-key", reason: "reserved" },
      { key: "anthropic-beta", reason: "reserved" },
      { key: "Host", reason: "reserved" },
      { key: "Content-Length", reason: "reserved" },
      { key: "Bad Header", reason: "invalid-key" },
      { key: "X-Line", reason: "invalid-value" },
    ],
  );
  assert.ok(result.issues.every((issue) => !("value" in issue)));
});

test("reports empty input, malformed JSON, and unterminated cURL quotes", () => {
  assert.throws(
    () => customHeaders.parseCustomHeadersImport("   "),
    errorHasCode("empty"),
  );
  assert.throws(
    () => customHeaders.parseCustomHeadersImport('{"X-Title":'),
    errorHasCode("invalid-json"),
  );
  assert.throws(
    () => customHeaders.parseCustomHeadersImport('curl -H "X-Title: open'),
    errorHasCode("unterminated-quote"),
  );
});

test("does not read @files and leaves current headers unchanged when nothing is valid", () => {
  const current = [{ key: "X-Existing", value: "unchanged" }];
  const fileResult = customHeaders.parseCustomHeadersImport("curl -H @headers.txt");
  assert.deepEqual(fileResult, {
    headers: [],
    issues: [{ reason: "malformed-header" }],
  });

  const protectedResult = customHeaders.parseCustomHeadersImport(
    '{"Authorization":"secret"}',
  );
  const merged = customHeaders.mergeImportedCustomHeaders(
    current,
    protectedResult.headers,
  );
  assert.deepEqual(merged, {
    headers: [{ key: "X-Existing", value: "unchanged" }],
    importedCount: 0,
    overwrittenCount: 0,
  });
  assert.deepEqual(current, [{ key: "X-Existing", value: "unchanged" }]);
});

test("parsed and saved headers reach runtime merge while CR/LF values are rejected", () => {
  const parsed = customHeaders.parseCustomHeadersImport(
    '{"X-Imported":"sentinel"}',
  );
  const saved = customHeaders.mergeImportedCustomHeaders([], parsed.headers);

  assert.deepEqual(
    customHeaders.mergeCustomHeaders(
      { Accept: "application/json" },
      [
        ...saved.headers,
        { key: "X-Line", value: "bad\nvalue" },
      ],
    ),
    {
      Accept: "application/json",
      "X-Imported": "sentinel",
    },
  );
});
