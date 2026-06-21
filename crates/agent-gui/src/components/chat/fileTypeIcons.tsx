import type { ComponentType, SVGProps } from "react";
import DefaultFile from "~icons/vscode-icons/default-file";
import DefaultFileSvg from "~icons/vscode-icons/default-file?raw";
import DefaultFolder from "~icons/vscode-icons/default-folder";
import DefaultFolderSvg from "~icons/vscode-icons/default-folder?raw";
import FileTypeAudio from "~icons/vscode-icons/file-type-audio";
import FileTypeAudioSvg from "~icons/vscode-icons/file-type-audio?raw";
import FileTypeBat from "~icons/vscode-icons/file-type-bat";
import FileTypeBatSvg from "~icons/vscode-icons/file-type-bat?raw";
import FileTypeBinary from "~icons/vscode-icons/file-type-binary";
import FileTypeBinarySvg from "~icons/vscode-icons/file-type-binary?raw";
import FileTypeC from "~icons/vscode-icons/file-type-c";
import FileTypeCSvg from "~icons/vscode-icons/file-type-c?raw";
import FileTypeConfig from "~icons/vscode-icons/file-type-config";
import FileTypeConfigSvg from "~icons/vscode-icons/file-type-config?raw";
import FileTypeCpp from "~icons/vscode-icons/file-type-cpp";
import FileTypeCppSvg from "~icons/vscode-icons/file-type-cpp?raw";
import FileTypeCsharp from "~icons/vscode-icons/file-type-csharp";
import FileTypeCsharpSvg from "~icons/vscode-icons/file-type-csharp?raw";
import FileTypeCss from "~icons/vscode-icons/file-type-css";
import FileTypeCssSvg from "~icons/vscode-icons/file-type-css?raw";
import FileTypeDart from "~icons/vscode-icons/file-type-dartlang";
import FileTypeDartSvg from "~icons/vscode-icons/file-type-dartlang?raw";
import FileTypeDocker from "~icons/vscode-icons/file-type-docker";
import FileTypeDockerSvg from "~icons/vscode-icons/file-type-docker?raw";
import FileTypeExcel from "~icons/vscode-icons/file-type-excel";
import FileTypeExcelSvg from "~icons/vscode-icons/file-type-excel?raw";
import FileTypeFont from "~icons/vscode-icons/file-type-font";
import FileTypeFontSvg from "~icons/vscode-icons/file-type-font?raw";
import FileTypeGit from "~icons/vscode-icons/file-type-git";
import FileTypeGitSvg from "~icons/vscode-icons/file-type-git?raw";
import FileTypeGo from "~icons/vscode-icons/file-type-go";
import FileTypeGoSvg from "~icons/vscode-icons/file-type-go?raw";
import FileTypeHtml from "~icons/vscode-icons/file-type-html";
import FileTypeHtmlSvg from "~icons/vscode-icons/file-type-html?raw";
import FileTypeImage from "~icons/vscode-icons/file-type-image";
import FileTypeImageSvg from "~icons/vscode-icons/file-type-image?raw";
import FileTypeJava from "~icons/vscode-icons/file-type-java";
import FileTypeJavaSvg from "~icons/vscode-icons/file-type-java?raw";
import FileTypeJs from "~icons/vscode-icons/file-type-js-official";
import FileTypeJsSvg from "~icons/vscode-icons/file-type-js-official?raw";
import FileTypeJson from "~icons/vscode-icons/file-type-json";
import FileTypeJsonSvg from "~icons/vscode-icons/file-type-json?raw";
import FileTypeKotlin from "~icons/vscode-icons/file-type-kotlin";
import FileTypeKotlinSvg from "~icons/vscode-icons/file-type-kotlin?raw";
import FileTypeLicense from "~icons/vscode-icons/file-type-license";
import FileTypeLicenseSvg from "~icons/vscode-icons/file-type-license?raw";
import FileTypeLog from "~icons/vscode-icons/file-type-log";
import FileTypeLogSvg from "~icons/vscode-icons/file-type-log?raw";
import FileTypeMarkdown from "~icons/vscode-icons/file-type-markdown";
import FileTypeMarkdownSvg from "~icons/vscode-icons/file-type-markdown?raw";
import FileTypePdf from "~icons/vscode-icons/file-type-pdf2";
import FileTypePdfSvg from "~icons/vscode-icons/file-type-pdf2?raw";
import FileTypePhp from "~icons/vscode-icons/file-type-php";
import FileTypePhpSvg from "~icons/vscode-icons/file-type-php?raw";
import FileTypePowerpoint from "~icons/vscode-icons/file-type-powerpoint";
import FileTypePowerpointSvg from "~icons/vscode-icons/file-type-powerpoint?raw";
import FileTypePowershell from "~icons/vscode-icons/file-type-powershell";
import FileTypePowershellSvg from "~icons/vscode-icons/file-type-powershell?raw";
import FileTypePython from "~icons/vscode-icons/file-type-python";
import FileTypePythonSvg from "~icons/vscode-icons/file-type-python?raw";
import FileTypeReactJs from "~icons/vscode-icons/file-type-reactjs";
import FileTypeReactJsSvg from "~icons/vscode-icons/file-type-reactjs?raw";
import FileTypeReactTs from "~icons/vscode-icons/file-type-reactts";
import FileTypeReactTsSvg from "~icons/vscode-icons/file-type-reactts?raw";
import FileTypeRuby from "~icons/vscode-icons/file-type-ruby";
import FileTypeRubySvg from "~icons/vscode-icons/file-type-ruby?raw";
import FileTypeRust from "~icons/vscode-icons/file-type-rust";
import FileTypeRustSvg from "~icons/vscode-icons/file-type-rust?raw";
import FileTypeShell from "~icons/vscode-icons/file-type-shell";
import FileTypeShellSvg from "~icons/vscode-icons/file-type-shell?raw";
import FileTypeSql from "~icons/vscode-icons/file-type-sql";
import FileTypeSqlSvg from "~icons/vscode-icons/file-type-sql?raw";
import FileTypeSvelte from "~icons/vscode-icons/file-type-svelte";
import FileTypeSvelteSvg from "~icons/vscode-icons/file-type-svelte?raw";
import FileTypeSvg from "~icons/vscode-icons/file-type-svg";
import FileTypeSvgSvg from "~icons/vscode-icons/file-type-svg?raw";
import FileTypeSwift from "~icons/vscode-icons/file-type-swift";
import FileTypeSwiftSvg from "~icons/vscode-icons/file-type-swift?raw";
import FileTypeText from "~icons/vscode-icons/file-type-text";
import FileTypeTextSvg from "~icons/vscode-icons/file-type-text?raw";
import FileTypeToml from "~icons/vscode-icons/file-type-toml";
import FileTypeTomlSvg from "~icons/vscode-icons/file-type-toml?raw";
import FileTypeTypescript from "~icons/vscode-icons/file-type-typescript-official";
import FileTypeTypescriptSvg from "~icons/vscode-icons/file-type-typescript-official?raw";
import FileTypeVideo from "~icons/vscode-icons/file-type-video";
import FileTypeVideoSvg from "~icons/vscode-icons/file-type-video?raw";
import FileTypeVue from "~icons/vscode-icons/file-type-vue";
import FileTypeVueSvg from "~icons/vscode-icons/file-type-vue?raw";
import FileTypeWord from "~icons/vscode-icons/file-type-word";
import FileTypeWordSvg from "~icons/vscode-icons/file-type-word?raw";
import FileTypeXml from "~icons/vscode-icons/file-type-xml";
import FileTypeXmlSvg from "~icons/vscode-icons/file-type-xml?raw";
import FileTypeYaml from "~icons/vscode-icons/file-type-yaml";
import FileTypeYamlSvg from "~icons/vscode-icons/file-type-yaml?raw";
import FileTypeZip from "~icons/vscode-icons/file-type-zip";
import FileTypeZipSvg from "~icons/vscode-icons/file-type-zip?raw";

type IconSource = ComponentType<SVGProps<SVGSVGElement>>;

const EXT_ICON: Record<string, IconSource> = {
  ts: FileTypeTypescript,
  mts: FileTypeTypescript,
  cts: FileTypeTypescript,
  tsx: FileTypeReactTs,
  js: FileTypeJs,
  mjs: FileTypeJs,
  cjs: FileTypeJs,
  jsx: FileTypeReactJs,
  py: FileTypePython,
  pyi: FileTypePython,
  rs: FileTypeRust,
  go: FileTypeGo,
  java: FileTypeJava,
  html: FileTypeHtml,
  htm: FileTypeHtml,
  css: FileTypeCss,
  scss: FileTypeCss,
  sass: FileTypeCss,
  less: FileTypeCss,
  json: FileTypeJson,
  jsonc: FileTypeJson,
  md: FileTypeMarkdown,
  mdx: FileTypeMarkdown,
  markdown: FileTypeMarkdown,
  yaml: FileTypeYaml,
  yml: FileTypeYaml,
  toml: FileTypeToml,
  vue: FileTypeVue,
  svelte: FileTypeSvelte,
  sh: FileTypeShell,
  bash: FileTypeShell,
  zsh: FileTypeShell,
  fish: FileTypeShell,
  bat: FileTypeBat,
  cmd: FileTypeBat,
  ps1: FileTypePowershell,
  png: FileTypeImage,
  jpg: FileTypeImage,
  jpeg: FileTypeImage,
  gif: FileTypeImage,
  webp: FileTypeImage,
  bmp: FileTypeImage,
  ico: FileTypeImage,
  avif: FileTypeImage,
  svg: FileTypeSvg,
  pdf: FileTypePdf,
  zip: FileTypeZip,
  tar: FileTypeZip,
  gz: FileTypeZip,
  tgz: FileTypeZip,
  rar: FileTypeZip,
  "7z": FileTypeZip,
  xml: FileTypeXml,
  sql: FileTypeSql,
  c: FileTypeC,
  h: FileTypeC,
  cpp: FileTypeCpp,
  cc: FileTypeCpp,
  cxx: FileTypeCpp,
  hpp: FileTypeCpp,
  cs: FileTypeCsharp,
  php: FileTypePhp,
  rb: FileTypeRuby,
  swift: FileTypeSwift,
  kt: FileTypeKotlin,
  kts: FileTypeKotlin,
  dart: FileTypeDart,
  log: FileTypeLog,
  csv: FileTypeExcel,
  tsv: FileTypeExcel,
  xls: FileTypeExcel,
  xlsx: FileTypeExcel,
  doc: FileTypeWord,
  docx: FileTypeWord,
  ppt: FileTypePowerpoint,
  pptx: FileTypePowerpoint,
  txt: FileTypeText,
  text: FileTypeText,
  rtf: FileTypeText,
  ttf: FileTypeFont,
  otf: FileTypeFont,
  woff: FileTypeFont,
  woff2: FileTypeFont,
  mp4: FileTypeVideo,
  mov: FileTypeVideo,
  webm: FileTypeVideo,
  mkv: FileTypeVideo,
  avi: FileTypeVideo,
  mp3: FileTypeAudio,
  wav: FileTypeAudio,
  flac: FileTypeAudio,
  ogg: FileTypeAudio,
  m4a: FileTypeAudio,
  exe: FileTypeBinary,
  dll: FileTypeBinary,
  so: FileTypeBinary,
  bin: FileTypeBinary,
  o: FileTypeBinary,
  wasm: FileTypeBinary,
};

const EXT_ICON_SVG = {
  ts: FileTypeTypescriptSvg,
  mts: FileTypeTypescriptSvg,
  cts: FileTypeTypescriptSvg,
  tsx: FileTypeReactTsSvg,
  js: FileTypeJsSvg,
  mjs: FileTypeJsSvg,
  cjs: FileTypeJsSvg,
  jsx: FileTypeReactJsSvg,
  py: FileTypePythonSvg,
  pyi: FileTypePythonSvg,
  rs: FileTypeRustSvg,
  go: FileTypeGoSvg,
  java: FileTypeJavaSvg,
  html: FileTypeHtmlSvg,
  htm: FileTypeHtmlSvg,
  css: FileTypeCssSvg,
  scss: FileTypeCssSvg,
  sass: FileTypeCssSvg,
  less: FileTypeCssSvg,
  json: FileTypeJsonSvg,
  jsonc: FileTypeJsonSvg,
  md: FileTypeMarkdownSvg,
  mdx: FileTypeMarkdownSvg,
  markdown: FileTypeMarkdownSvg,
  yaml: FileTypeYamlSvg,
  yml: FileTypeYamlSvg,
  toml: FileTypeTomlSvg,
  vue: FileTypeVueSvg,
  svelte: FileTypeSvelteSvg,
  sh: FileTypeShellSvg,
  bash: FileTypeShellSvg,
  zsh: FileTypeShellSvg,
  fish: FileTypeShellSvg,
  bat: FileTypeBatSvg,
  cmd: FileTypeBatSvg,
  ps1: FileTypePowershellSvg,
  png: FileTypeImageSvg,
  jpg: FileTypeImageSvg,
  jpeg: FileTypeImageSvg,
  gif: FileTypeImageSvg,
  webp: FileTypeImageSvg,
  bmp: FileTypeImageSvg,
  ico: FileTypeImageSvg,
  avif: FileTypeImageSvg,
  svg: FileTypeSvgSvg,
  pdf: FileTypePdfSvg,
  zip: FileTypeZipSvg,
  tar: FileTypeZipSvg,
  gz: FileTypeZipSvg,
  tgz: FileTypeZipSvg,
  rar: FileTypeZipSvg,
  "7z": FileTypeZipSvg,
  xml: FileTypeXmlSvg,
  sql: FileTypeSqlSvg,
  c: FileTypeCSvg,
  h: FileTypeCSvg,
  cpp: FileTypeCppSvg,
  cc: FileTypeCppSvg,
  cxx: FileTypeCppSvg,
  hpp: FileTypeCppSvg,
  cs: FileTypeCsharpSvg,
  php: FileTypePhpSvg,
  rb: FileTypeRubySvg,
  swift: FileTypeSwiftSvg,
  kt: FileTypeKotlinSvg,
  kts: FileTypeKotlinSvg,
  dart: FileTypeDartSvg,
  log: FileTypeLogSvg,
  csv: FileTypeExcelSvg,
  tsv: FileTypeExcelSvg,
  xls: FileTypeExcelSvg,
  xlsx: FileTypeExcelSvg,
  doc: FileTypeWordSvg,
  docx: FileTypeWordSvg,
  ppt: FileTypePowerpointSvg,
  pptx: FileTypePowerpointSvg,
  txt: FileTypeTextSvg,
  text: FileTypeTextSvg,
  rtf: FileTypeTextSvg,
  ttf: FileTypeFontSvg,
  otf: FileTypeFontSvg,
  woff: FileTypeFontSvg,
  woff2: FileTypeFontSvg,
  mp4: FileTypeVideoSvg,
  mov: FileTypeVideoSvg,
  webm: FileTypeVideoSvg,
  mkv: FileTypeVideoSvg,
  avi: FileTypeVideoSvg,
  mp3: FileTypeAudioSvg,
  wav: FileTypeAudioSvg,
  flac: FileTypeAudioSvg,
  ogg: FileTypeAudioSvg,
  m4a: FileTypeAudioSvg,
  exe: FileTypeBinarySvg,
  dll: FileTypeBinarySvg,
  so: FileTypeBinarySvg,
  bin: FileTypeBinarySvg,
  o: FileTypeBinarySvg,
  wasm: FileTypeBinarySvg,
} as unknown as Record<string, string>;

const NAME_ICON: Record<string, IconSource> = {
  dockerfile: FileTypeDocker,
  "docker-compose.yml": FileTypeDocker,
  "docker-compose.yaml": FileTypeDocker,
  ".gitignore": FileTypeGit,
  ".gitattributes": FileTypeGit,
  ".gitmodules": FileTypeGit,
  ".gitkeep": FileTypeGit,
  license: FileTypeLicense,
  "license.md": FileTypeLicense,
  "license.txt": FileTypeLicense,
  ".env": FileTypeConfig,
  ".env.local": FileTypeConfig,
  ".env.development": FileTypeConfig,
  ".env.production": FileTypeConfig,
  ".editorconfig": FileTypeConfig,
  ".prettierrc": FileTypeConfig,
  ".eslintrc": FileTypeConfig,
  ".npmrc": FileTypeConfig,
  ".nvmrc": FileTypeConfig,
  makefile: FileTypeShell,
  "package-lock.json": FileTypeJson,
  "pnpm-lock.yaml": FileTypeYaml,
  "cargo.lock": FileTypeToml,
};

const NAME_ICON_SVG = {
  dockerfile: FileTypeDockerSvg,
  "docker-compose.yml": FileTypeDockerSvg,
  "docker-compose.yaml": FileTypeDockerSvg,
  ".gitignore": FileTypeGitSvg,
  ".gitattributes": FileTypeGitSvg,
  ".gitmodules": FileTypeGitSvg,
  ".gitkeep": FileTypeGitSvg,
  license: FileTypeLicenseSvg,
  "license.md": FileTypeLicenseSvg,
  "license.txt": FileTypeLicenseSvg,
  ".env": FileTypeConfigSvg,
  ".env.local": FileTypeConfigSvg,
  ".env.development": FileTypeConfigSvg,
  ".env.production": FileTypeConfigSvg,
  ".editorconfig": FileTypeConfigSvg,
  ".prettierrc": FileTypeConfigSvg,
  ".eslintrc": FileTypeConfigSvg,
  ".npmrc": FileTypeConfigSvg,
  ".nvmrc": FileTypeConfigSvg,
  makefile: FileTypeShellSvg,
  "package-lock.json": FileTypeJsonSvg,
  "pnpm-lock.yaml": FileTypeYamlSvg,
  "cargo.lock": FileTypeTomlSvg,
} as unknown as Record<string, string>;

function lastSegment(path: string) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function extOf(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function getFileTypeIcon(path: string, kind: "file" | "dir"): IconSource {
  if (kind === "dir") return DefaultFolder;
  const name = lastSegment(path).toLowerCase();
  const byName = NAME_ICON[name];
  if (byName) return byName;
  const ext = extOf(name);
  if (ext && EXT_ICON[ext]) return EXT_ICON[ext];
  return DefaultFile;
}

export function getFileTypeIconSvg(path: string, kind: "file" | "dir"): string {
  if (kind === "dir") return DefaultFolderSvg as unknown as string;
  const name = lastSegment(path).toLowerCase();
  const byName = NAME_ICON_SVG[name];
  if (byName) return byName;
  const ext = extOf(name);
  if (ext && EXT_ICON_SVG[ext]) return EXT_ICON_SVG[ext];
  return DefaultFileSvg as unknown as string;
}

export type FileTypeIconComponent = IconSource;
