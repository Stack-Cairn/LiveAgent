import type { ComponentType, SVGProps } from "react";
import FileTypeAudio from "~icons/material-icon-theme/audio";
import FileTypeAudioSvg from "~icons/material-icon-theme/audio?raw";
import FileTypeBun from "~icons/material-icon-theme/bun";
import FileTypeBunSvg from "~icons/material-icon-theme/bun?raw";
import FileTypeC from "~icons/material-icon-theme/c";
import FileTypeCSvg from "~icons/material-icon-theme/c?raw";
import FileTypeCertificate from "~icons/material-icon-theme/certificate";
import FileTypeCertificateSvg from "~icons/material-icon-theme/certificate?raw";
import FileTypeCmake from "~icons/material-icon-theme/cmake";
import FileTypeCmakeSvg from "~icons/material-icon-theme/cmake?raw";
import FileTypeBat from "~icons/material-icon-theme/console";
import FileTypeShell from "~icons/material-icon-theme/console";
import FileTypeBatSvg from "~icons/material-icon-theme/console?raw";
import FileTypeShellSvg from "~icons/material-icon-theme/console?raw";
import FileTypeCpp from "~icons/material-icon-theme/cpp";
import FileTypeCppSvg from "~icons/material-icon-theme/cpp?raw";
import FileTypeCsharp from "~icons/material-icon-theme/csharp";
import FileTypeCsharpSvg from "~icons/material-icon-theme/csharp?raw";
import FileTypeCss from "~icons/material-icon-theme/css";
import FileTypeCssSvg from "~icons/material-icon-theme/css?raw";
import FileTypeDart from "~icons/material-icon-theme/dart";
import FileTypeDartSvg from "~icons/material-icon-theme/dart?raw";
import FileTypeSql from "~icons/material-icon-theme/database";
import FileTypeSqlSvg from "~icons/material-icon-theme/database?raw";
import FileTypeDocker from "~icons/material-icon-theme/docker";
import FileTypeDockerSvg from "~icons/material-icon-theme/docker?raw";
import DefaultFile from "~icons/material-icon-theme/document";
import FileTypeText from "~icons/material-icon-theme/document";
import DefaultFileSvg from "~icons/material-icon-theme/document?raw";
import FileTypeTextSvg from "~icons/material-icon-theme/document?raw";
import FileTypeEditorConfig from "~icons/material-icon-theme/editorconfig";
import FileTypeEditorConfigSvg from "~icons/material-icon-theme/editorconfig?raw";
import FileTypeEslint from "~icons/material-icon-theme/eslint";
import FileTypeEslintSvg from "~icons/material-icon-theme/eslint?raw";
import FileTypeBinary from "~icons/material-icon-theme/exe";
import FileTypeBinarySvg from "~icons/material-icon-theme/exe?raw";
import FolderTypeApi from "~icons/material-icon-theme/folder-api";
import FolderTypeApiOpened from "~icons/material-icon-theme/folder-api-open";
import FolderTypeApp from "~icons/material-icon-theme/folder-app";
import FolderTypeAppOpened from "~icons/material-icon-theme/folder-app-open";
import FolderTypeBinary from "~icons/material-icon-theme/folder-archive";
import FolderTypeBinaryOpened from "~icons/material-icon-theme/folder-archive-open";
import FolderTypeWasm from "~icons/material-icon-theme/folder-assembly";
import FolderTypeWasmOpened from "~icons/material-icon-theme/folder-assembly-open";
import FolderTypeModel from "~icons/material-icon-theme/folder-class";
import FolderTypeModelOpened from "~icons/material-icon-theme/folder-class-open";
import FolderTypeClient from "~icons/material-icon-theme/folder-client";
import FolderTypeClientOpened from "~icons/material-icon-theme/folder-client-open";
import FolderTypeComponent from "~icons/material-icon-theme/folder-components";
import FolderTypeComponentOpened from "~icons/material-icon-theme/folder-components-open";
import FolderTypeConfig from "~icons/material-icon-theme/folder-config";
import FolderTypeConfigOpened from "~icons/material-icon-theme/folder-config-open";
import FolderTypeController from "~icons/material-icon-theme/folder-controller";
import FolderTypeControllerOpened from "~icons/material-icon-theme/folder-controller-open";
import FolderTypeCoverage from "~icons/material-icon-theme/folder-coverage";
import FolderTypeCoverageOpened from "~icons/material-icon-theme/folder-coverage-open";
import FolderTypeStyle from "~icons/material-icon-theme/folder-css";
import FolderTypeStyleOpened from "~icons/material-icon-theme/folder-css-open";
import FolderTypeCypress from "~icons/material-icon-theme/folder-cypress";
import FolderTypeCypressOpened from "~icons/material-icon-theme/folder-cypress-open";
import FolderTypeDb from "~icons/material-icon-theme/folder-database";
import FolderTypeDbOpened from "~icons/material-icon-theme/folder-database-open";
import FolderTypeDist from "~icons/material-icon-theme/folder-dist";
import FolderTypeDistOpened from "~icons/material-icon-theme/folder-dist-open";
import FolderTypeDocker from "~icons/material-icon-theme/folder-docker";
import FolderTypeDockerOpened from "~icons/material-icon-theme/folder-docker-open";
import FolderTypeDocs from "~icons/material-icon-theme/folder-docs";
import FolderTypeDocsOpened from "~icons/material-icon-theme/folder-docs-open";
import FolderTypeFonts from "~icons/material-icon-theme/folder-font";
import FolderTypeFontsOpened from "~icons/material-icon-theme/folder-font-open";
import FolderTypeGit from "~icons/material-icon-theme/folder-git";
import FolderTypeGitOpened from "~icons/material-icon-theme/folder-git-open";
import FolderTypeGithub from "~icons/material-icon-theme/folder-github";
import FolderTypeGithubOpened from "~icons/material-icon-theme/folder-github-open";
import FolderTypeHelper from "~icons/material-icon-theme/folder-helper";
import FolderTypeHelperOpened from "~icons/material-icon-theme/folder-helper-open";
import FolderTypeHook from "~icons/material-icon-theme/folder-hook";
import FolderTypeHookOpened from "~icons/material-icon-theme/folder-hook-open";
import FolderTypeLocale from "~icons/material-icon-theme/folder-i18n";
import FolderTypeLocaleOpened from "~icons/material-icon-theme/folder-i18n-open";
import FolderTypeImages from "~icons/material-icon-theme/folder-images";
import FolderTypeImagesOpened from "~icons/material-icon-theme/folder-images-open";
import FolderTypeInclude from "~icons/material-icon-theme/folder-include";
import FolderTypeIncludeOpened from "~icons/material-icon-theme/folder-include-open";
import FolderTypeInterfaces from "~icons/material-icon-theme/folder-interface";
import FolderTypeInterfacesOpened from "~icons/material-icon-theme/folder-interface-open";
import FolderTypeIos from "~icons/material-icon-theme/folder-ios";
import FolderTypeIosOpened from "~icons/material-icon-theme/folder-ios-open";
import FolderTypeLibrary from "~icons/material-icon-theme/folder-lib";
import FolderTypeLibraryOpened from "~icons/material-icon-theme/folder-lib-open";
import FolderTypeLog from "~icons/material-icon-theme/folder-log";
import FolderTypeLogOpened from "~icons/material-icon-theme/folder-log-open";
import FolderTypeMiddleware from "~icons/material-icon-theme/folder-middleware";
import FolderTypeMiddlewareOpened from "~icons/material-icon-theme/folder-middleware-open";
import FolderTypeMock from "~icons/material-icon-theme/folder-mock";
import FolderTypeMockOpened from "~icons/material-icon-theme/folder-mock-open";
import FolderTypeNext from "~icons/material-icon-theme/folder-next";
import FolderTypeNextOpened from "~icons/material-icon-theme/folder-next-open";
import FolderTypeNode from "~icons/material-icon-theme/folder-node";
import FolderTypeNodeOpened from "~icons/material-icon-theme/folder-node-open";
import FolderTypeModule from "~icons/material-icon-theme/folder-packages";
import FolderTypePackage from "~icons/material-icon-theme/folder-packages";
import FolderTypeModuleOpened from "~icons/material-icon-theme/folder-packages-open";
import FolderTypePackageOpened from "~icons/material-icon-theme/folder-packages-open";
import FolderTypePlugin from "~icons/material-icon-theme/folder-plugin";
import FolderTypePluginOpened from "~icons/material-icon-theme/folder-plugin-open";
import FolderTypePrivate from "~icons/material-icon-theme/folder-private";
import FolderTypePrivateOpened from "~icons/material-icon-theme/folder-private-open";
import DefaultFolder from "~icons/material-icon-theme/folder-project";
import DefaultFolderSvg from "~icons/material-icon-theme/folder-project?raw";
import DefaultFolderOpened from "~icons/material-icon-theme/folder-project-open";
import FolderTypePublic from "~icons/material-icon-theme/folder-public";
import FolderTypeWww from "~icons/material-icon-theme/folder-public";
import FolderTypePublicOpened from "~icons/material-icon-theme/folder-public-open";
import FolderTypeWwwOpened from "~icons/material-icon-theme/folder-public-open";
import FolderTypePython from "~icons/material-icon-theme/folder-python";
import FolderTypePythonOpened from "~icons/material-icon-theme/folder-python-open";
import FolderTypeAsset from "~icons/material-icon-theme/folder-resource";
import FolderTypeAssetOpened from "~icons/material-icon-theme/folder-resource-open";
import FolderTypeRoute from "~icons/material-icon-theme/folder-routes";
import FolderTypeRouteOpened from "~icons/material-icon-theme/folder-routes-open";
import FolderTypeScript from "~icons/material-icon-theme/folder-scripts";
import FolderTypeScriptOpened from "~icons/material-icon-theme/folder-scripts-open";
import FolderTypeServer from "~icons/material-icon-theme/folder-server";
import FolderTypeServerOpened from "~icons/material-icon-theme/folder-server-open";
import FolderTypeShared from "~icons/material-icon-theme/folder-shared";
import FolderTypeSharedOpened from "~icons/material-icon-theme/folder-shared-open";
import FolderTypeSrc from "~icons/material-icon-theme/folder-src";
import FolderTypeSrcOpened from "~icons/material-icon-theme/folder-src-open";
import FolderTypeTauri from "~icons/material-icon-theme/folder-src-tauri";
import FolderTypeTauriOpened from "~icons/material-icon-theme/folder-src-tauri-open";
import FolderTypeStory from "~icons/material-icon-theme/folder-storybook";
import FolderTypeStoryOpened from "~icons/material-icon-theme/folder-storybook-open";
import FolderTypeTemp from "~icons/material-icon-theme/folder-temp";
import FolderTypeTempOpened from "~icons/material-icon-theme/folder-temp-open";
import FolderTypeTemplate from "~icons/material-icon-theme/folder-template";
import FolderTypeTemplateOpened from "~icons/material-icon-theme/folder-template-open";
import FolderTypeE2e from "~icons/material-icon-theme/folder-test";
import FolderTypeTest from "~icons/material-icon-theme/folder-test";
import FolderTypeE2eOpened from "~icons/material-icon-theme/folder-test-open";
import FolderTypeTestOpened from "~icons/material-icon-theme/folder-test-open";
import FolderTypeTheme from "~icons/material-icon-theme/folder-theme";
import FolderTypeThemeOpened from "~icons/material-icon-theme/folder-theme-open";
import FolderTypeTools from "~icons/material-icon-theme/folder-tools";
import FolderTypeToolsOpened from "~icons/material-icon-theme/folder-tools-open";
import FolderTypeTypescript from "~icons/material-icon-theme/folder-typescript";
import FolderTypeTypings from "~icons/material-icon-theme/folder-typescript";
import FolderTypeTypescriptOpened from "~icons/material-icon-theme/folder-typescript-open";
import FolderTypeTypingsOpened from "~icons/material-icon-theme/folder-typescript-open";
import FolderTypeVideo from "~icons/material-icon-theme/folder-video";
import FolderTypeVideoOpened from "~icons/material-icon-theme/folder-video-open";
import FolderTypeView from "~icons/material-icon-theme/folder-views";
import FolderTypeViewOpened from "~icons/material-icon-theme/folder-views-open";
import FolderTypeVscode from "~icons/material-icon-theme/folder-vscode";
import FolderTypeVscodeOpened from "~icons/material-icon-theme/folder-vscode-open";
import FolderTypeWebpack from "~icons/material-icon-theme/folder-webpack";
import FolderTypeWebpackOpened from "~icons/material-icon-theme/folder-webpack-open";
import FileTypeFont from "~icons/material-icon-theme/font";
import FileTypeFontSvg from "~icons/material-icon-theme/font?raw";
import FileTypeGit from "~icons/material-icon-theme/git";
import FileTypeGitSvg from "~icons/material-icon-theme/git?raw";
import FileTypeGo from "~icons/material-icon-theme/go";
import FileTypeGoSvg from "~icons/material-icon-theme/go?raw";
import FileTypeGoMod from "~icons/material-icon-theme/go-mod";
import FileTypeGoModSvg from "~icons/material-icon-theme/go-mod?raw";
import FileTypeGradle from "~icons/material-icon-theme/gradle";
import FileTypeGradleSvg from "~icons/material-icon-theme/gradle?raw";
import FileTypeGraphql from "~icons/material-icon-theme/graphql";
import FileTypeGraphqlSvg from "~icons/material-icon-theme/graphql?raw";
import FileTypeHtml from "~icons/material-icon-theme/html";
import FileTypeHtmlSvg from "~icons/material-icon-theme/html?raw";
import FileTypeImage from "~icons/material-icon-theme/image";
import FileTypeImageSvg from "~icons/material-icon-theme/image?raw";
import FileTypeJava from "~icons/material-icon-theme/java";
import FileTypeJavaSvg from "~icons/material-icon-theme/java?raw";
import FileTypeJs from "~icons/material-icon-theme/javascript";
import FileTypeJsSvg from "~icons/material-icon-theme/javascript?raw";
import FileTypeJsConfig from "~icons/material-icon-theme/jsconfig";
import FileTypeJsConfigSvg from "~icons/material-icon-theme/jsconfig?raw";
import FileTypeJson from "~icons/material-icon-theme/json";
import FileTypeJsonSvg from "~icons/material-icon-theme/json?raw";
import FileTypeKey from "~icons/material-icon-theme/key";
import FileTypeKeySvg from "~icons/material-icon-theme/key?raw";
import FileTypeKotlin from "~icons/material-icon-theme/kotlin";
import FileTypeKotlinSvg from "~icons/material-icon-theme/kotlin?raw";
import FileTypeLicense from "~icons/material-icon-theme/license";
import FileTypeLicenseSvg from "~icons/material-icon-theme/license?raw";
import FileTypeLock from "~icons/material-icon-theme/lock";
import FileTypeLockSvg from "~icons/material-icon-theme/lock?raw";
import FileTypeLog from "~icons/material-icon-theme/log";
import FileTypeLogSvg from "~icons/material-icon-theme/log?raw";
import FileTypeMakefile from "~icons/material-icon-theme/makefile";
import FileTypeMakefileSvg from "~icons/material-icon-theme/makefile?raw";
import FileTypeMarkdown from "~icons/material-icon-theme/markdown";
import FileTypeMarkdownSvg from "~icons/material-icon-theme/markdown?raw";
import FileTypeMaven from "~icons/material-icon-theme/maven";
import FileTypeMavenSvg from "~icons/material-icon-theme/maven?raw";
import FileTypeNginx from "~icons/material-icon-theme/nginx";
import FileTypeNginxSvg from "~icons/material-icon-theme/nginx?raw";
import FileTypeNode from "~icons/material-icon-theme/nodejs";
import FileTypeNodeSvg from "~icons/material-icon-theme/nodejs?raw";
import FileTypeNpm from "~icons/material-icon-theme/npm";
import FileTypeNpmSvg from "~icons/material-icon-theme/npm?raw";
import FileTypePdf from "~icons/material-icon-theme/pdf";
import FileTypePdfSvg from "~icons/material-icon-theme/pdf?raw";
import FileTypePhp from "~icons/material-icon-theme/php";
import FileTypePhpSvg from "~icons/material-icon-theme/php?raw";
import FileTypePnpm from "~icons/material-icon-theme/pnpm";
import FileTypePnpmSvg from "~icons/material-icon-theme/pnpm?raw";
import FileTypePowerpoint from "~icons/material-icon-theme/powerpoint";
import FileTypePowerpointSvg from "~icons/material-icon-theme/powerpoint?raw";
import FileTypePowershell from "~icons/material-icon-theme/powershell";
import FileTypePowershellSvg from "~icons/material-icon-theme/powershell?raw";
import FileTypePrettier from "~icons/material-icon-theme/prettier";
import FileTypePrettierSvg from "~icons/material-icon-theme/prettier?raw";
import FileTypePrisma from "~icons/material-icon-theme/prisma";
import FileTypePrismaSvg from "~icons/material-icon-theme/prisma?raw";
import FileTypePython from "~icons/material-icon-theme/python";
import FileTypePythonSvg from "~icons/material-icon-theme/python?raw";
import FileTypeReactJs from "~icons/material-icon-theme/react";
import FileTypeReactJsSvg from "~icons/material-icon-theme/react?raw";
import FileTypeReactTs from "~icons/material-icon-theme/react-ts";
import FileTypeReactTsSvg from "~icons/material-icon-theme/react-ts?raw";
import FileTypeRuby from "~icons/material-icon-theme/ruby";
import FileTypeRubySvg from "~icons/material-icon-theme/ruby?raw";
import FileTypeRust from "~icons/material-icon-theme/rust";
import FileTypeRustSvg from "~icons/material-icon-theme/rust?raw";
import FileTypeSass from "~icons/material-icon-theme/sass";
import FileTypeSassSvg from "~icons/material-icon-theme/sass?raw";
import FileTypeConfig from "~icons/material-icon-theme/settings";
import FileTypeConfigSvg from "~icons/material-icon-theme/settings?raw";
import FileTypeSvelte from "~icons/material-icon-theme/svelte";
import FileTypeSvelteSvg from "~icons/material-icon-theme/svelte?raw";
import FileTypeSvg from "~icons/material-icon-theme/svg";
import FileTypeSvgSvg from "~icons/material-icon-theme/svg?raw";
import FileTypeSwift from "~icons/material-icon-theme/swift";
import FileTypeSwiftSvg from "~icons/material-icon-theme/swift?raw";
import FileTypeSystemd from "~icons/material-icon-theme/systemd";
import FileTypeSystemdSvg from "~icons/material-icon-theme/systemd?raw";
import FileTypeExcel from "~icons/material-icon-theme/table";
import FileTypeExcelSvg from "~icons/material-icon-theme/table?raw";
import FileTypeTerraform from "~icons/material-icon-theme/terraform";
import FileTypeTerraformSvg from "~icons/material-icon-theme/terraform?raw";
import FileTypeToml from "~icons/material-icon-theme/toml";
import FileTypeTomlSvg from "~icons/material-icon-theme/toml?raw";
import FileTypeTsConfig from "~icons/material-icon-theme/tsconfig";
import FileTypeTsConfigSvg from "~icons/material-icon-theme/tsconfig?raw";
import FileTypeTypescript from "~icons/material-icon-theme/typescript";
import FileTypeTypescriptSvg from "~icons/material-icon-theme/typescript?raw";
import FileTypeTsDef from "~icons/material-icon-theme/typescript-def";
import FileTypeTsDefSvg from "~icons/material-icon-theme/typescript-def?raw";
import FileTypeVideo from "~icons/material-icon-theme/video";
import FileTypeVideoSvg from "~icons/material-icon-theme/video?raw";
import FileTypeVite from "~icons/material-icon-theme/vite";
import FileTypeViteSvg from "~icons/material-icon-theme/vite?raw";
import FileTypeVitest from "~icons/material-icon-theme/vitest";
import FileTypeVitestSvg from "~icons/material-icon-theme/vitest?raw";
import FileTypeVue from "~icons/material-icon-theme/vue";
import FileTypeVueSvg from "~icons/material-icon-theme/vue?raw";
import FileTypeWebpack from "~icons/material-icon-theme/webpack";
import FileTypeWebpackSvg from "~icons/material-icon-theme/webpack?raw";
import FileTypeWord from "~icons/material-icon-theme/word";
import FileTypeWordSvg from "~icons/material-icon-theme/word?raw";
import FileTypeXml from "~icons/material-icon-theme/xml";
import FileTypeXmlSvg from "~icons/material-icon-theme/xml?raw";
import FileTypeYaml from "~icons/material-icon-theme/yaml";
import FileTypeYamlSvg from "~icons/material-icon-theme/yaml?raw";
import FileTypeYarn from "~icons/material-icon-theme/yarn";
import FileTypeYarnSvg from "~icons/material-icon-theme/yarn?raw";
import FileTypeZip from "~icons/material-icon-theme/zip";
import FileTypeZipSvg from "~icons/material-icon-theme/zip?raw";

type IconSource = ComponentType<SVGProps<SVGSVGElement>>;

type FolderIconPair = {
  closed: IconSource;
  opened: IconSource;
};

type FileTypeIconOptions = {
  expanded?: boolean;
};

function folderIcon(closed: IconSource, opened: IconSource): FolderIconPair {
  return { closed, opened };
}

const DEFAULT_FOLDER_ICON = folderIcon(DefaultFolder, DefaultFolderOpened);

const FOLDER_ICON: Record<string, FolderIconPair> = {
  ".config": folderIcon(FolderTypeConfig, FolderTypeConfigOpened),
  ".docker": folderIcon(FolderTypeDocker, FolderTypeDockerOpened),
  ".git": folderIcon(FolderTypeGit, FolderTypeGitOpened),
  ".github": folderIcon(FolderTypeGithub, FolderTypeGithubOpened),
  ".next": folderIcon(FolderTypeNext, FolderTypeNextOpened),
  ".private": folderIcon(FolderTypePrivate, FolderTypePrivateOpened),
  ".tmp": folderIcon(FolderTypeTemp, FolderTypeTempOpened),
  ".vscode": folderIcon(FolderTypeVscode, FolderTypeVscodeOpened),
  __mocks__: folderIcon(FolderTypeMock, FolderTypeMockOpened),
  __pycache__: folderIcon(FolderTypePython, FolderTypePythonOpened),
  __tests__: folderIcon(FolderTypeTest, FolderTypeTestOpened),
  "@types": folderIcon(FolderTypeTypings, FolderTypeTypingsOpened),
  api: folderIcon(FolderTypeApi, FolderTypeApiOpened),
  apis: folderIcon(FolderTypeApi, FolderTypeApiOpened),
  app: folderIcon(FolderTypeApp, FolderTypeAppOpened),
  apps: folderIcon(FolderTypeApp, FolderTypeAppOpened),
  asset: folderIcon(FolderTypeAsset, FolderTypeAssetOpened),
  assets: folderIcon(FolderTypeAsset, FolderTypeAssetOpened),
  backend: folderIcon(FolderTypeServer, FolderTypeServerOpened),
  bin: folderIcon(FolderTypeBinary, FolderTypeBinaryOpened),
  build: folderIcon(FolderTypeDist, FolderTypeDistOpened),
  client: folderIcon(FolderTypeClient, FolderTypeClientOpened),
  clients: folderIcon(FolderTypeClient, FolderTypeClientOpened),
  common: folderIcon(FolderTypeShared, FolderTypeSharedOpened),
  component: folderIcon(FolderTypeComponent, FolderTypeComponentOpened),
  components: folderIcon(FolderTypeComponent, FolderTypeComponentOpened),
  config: folderIcon(FolderTypeConfig, FolderTypeConfigOpened),
  configs: folderIcon(FolderTypeConfig, FolderTypeConfigOpened),
  container: folderIcon(FolderTypeDocker, FolderTypeDockerOpened),
  containers: folderIcon(FolderTypeDocker, FolderTypeDockerOpened),
  controller: folderIcon(FolderTypeController, FolderTypeControllerOpened),
  controllers: folderIcon(FolderTypeController, FolderTypeControllerOpened),
  coverage: folderIcon(FolderTypeCoverage, FolderTypeCoverageOpened),
  crates: folderIcon(FolderTypePackage, FolderTypePackageOpened),
  css: folderIcon(FolderTypeStyle, FolderTypeStyleOpened),
  cypress: folderIcon(FolderTypeCypress, FolderTypeCypressOpened),
  database: folderIcon(FolderTypeDb, FolderTypeDbOpened),
  db: folderIcon(FolderTypeDb, FolderTypeDbOpened),
  dist: folderIcon(FolderTypeDist, FolderTypeDistOpened),
  docker: folderIcon(FolderTypeDocker, FolderTypeDockerOpened),
  doc: folderIcon(FolderTypeDocs, FolderTypeDocsOpened),
  docs: folderIcon(FolderTypeDocs, FolderTypeDocsOpened),
  documentation: folderIcon(FolderTypeDocs, FolderTypeDocsOpened),
  e2e: folderIcon(FolderTypeE2e, FolderTypeE2eOpened),
  fixture: folderIcon(FolderTypeMock, FolderTypeMockOpened),
  fixtures: folderIcon(FolderTypeMock, FolderTypeMockOpened),
  font: folderIcon(FolderTypeFonts, FolderTypeFontsOpened),
  fonts: folderIcon(FolderTypeFonts, FolderTypeFontsOpened),
  frontend: folderIcon(FolderTypeClient, FolderTypeClientOpened),
  helper: folderIcon(FolderTypeHelper, FolderTypeHelperOpened),
  helpers: folderIcon(FolderTypeHelper, FolderTypeHelperOpened),
  hook: folderIcon(FolderTypeHook, FolderTypeHookOpened),
  hooks: folderIcon(FolderTypeHook, FolderTypeHookOpened),
  i18n: folderIcon(FolderTypeLocale, FolderTypeLocaleOpened),
  icon: folderIcon(FolderTypeImages, FolderTypeImagesOpened),
  icons: folderIcon(FolderTypeImages, FolderTypeImagesOpened),
  image: folderIcon(FolderTypeImages, FolderTypeImagesOpened),
  images: folderIcon(FolderTypeImages, FolderTypeImagesOpened),
  img: folderIcon(FolderTypeImages, FolderTypeImagesOpened),
  include: folderIcon(FolderTypeInclude, FolderTypeIncludeOpened),
  includes: folderIcon(FolderTypeInclude, FolderTypeIncludeOpened),
  interface: folderIcon(FolderTypeInterfaces, FolderTypeInterfacesOpened),
  interfaces: folderIcon(FolderTypeInterfaces, FolderTypeInterfacesOpened),
  ios: folderIcon(FolderTypeIos, FolderTypeIosOpened),
  lang: folderIcon(FolderTypeLocale, FolderTypeLocaleOpened),
  lib: folderIcon(FolderTypeLibrary, FolderTypeLibraryOpened),
  libs: folderIcon(FolderTypeLibrary, FolderTypeLibraryOpened),
  library: folderIcon(FolderTypeLibrary, FolderTypeLibraryOpened),
  locale: folderIcon(FolderTypeLocale, FolderTypeLocaleOpened),
  locales: folderIcon(FolderTypeLocale, FolderTypeLocaleOpened),
  log: folderIcon(FolderTypeLog, FolderTypeLogOpened),
  logs: folderIcon(FolderTypeLog, FolderTypeLogOpened),
  middleware: folderIcon(FolderTypeMiddleware, FolderTypeMiddlewareOpened),
  middlewares: folderIcon(FolderTypeMiddleware, FolderTypeMiddlewareOpened),
  migration: folderIcon(FolderTypeDb, FolderTypeDbOpened),
  migrations: folderIcon(FolderTypeDb, FolderTypeDbOpened),
  mock: folderIcon(FolderTypeMock, FolderTypeMockOpened),
  mocks: folderIcon(FolderTypeMock, FolderTypeMockOpened),
  model: folderIcon(FolderTypeModel, FolderTypeModelOpened),
  models: folderIcon(FolderTypeModel, FolderTypeModelOpened),
  module: folderIcon(FolderTypeModule, FolderTypeModuleOpened),
  modules: folderIcon(FolderTypeModule, FolderTypeModuleOpened),
  next: folderIcon(FolderTypeNext, FolderTypeNextOpened),
  node_modules: folderIcon(FolderTypeNode, FolderTypeNodeOpened),
  out: folderIcon(FolderTypeDist, FolderTypeDistOpened),
  package: folderIcon(FolderTypePackage, FolderTypePackageOpened),
  packages: folderIcon(FolderTypePackage, FolderTypePackageOpened),
  pages: folderIcon(FolderTypeView, FolderTypeViewOpened),
  plugin: folderIcon(FolderTypePlugin, FolderTypePluginOpened),
  plugins: folderIcon(FolderTypePlugin, FolderTypePluginOpened),
  private: folderIcon(FolderTypePrivate, FolderTypePrivateOpened),
  public: folderIcon(FolderTypePublic, FolderTypePublicOpened),
  py: folderIcon(FolderTypePython, FolderTypePythonOpened),
  python: folderIcon(FolderTypePython, FolderTypePythonOpened),
  resource: folderIcon(FolderTypeAsset, FolderTypeAssetOpened),
  resources: folderIcon(FolderTypeAsset, FolderTypeAssetOpened),
  route: folderIcon(FolderTypeRoute, FolderTypeRouteOpened),
  router: folderIcon(FolderTypeRoute, FolderTypeRouteOpened),
  routes: folderIcon(FolderTypeRoute, FolderTypeRouteOpened),
  screenshot: folderIcon(FolderTypeImages, FolderTypeImagesOpened),
  screenshots: folderIcon(FolderTypeImages, FolderTypeImagesOpened),
  script: folderIcon(FolderTypeScript, FolderTypeScriptOpened),
  scripts: folderIcon(FolderTypeScript, FolderTypeScriptOpened),
  server: folderIcon(FolderTypeServer, FolderTypeServerOpened),
  servers: folderIcon(FolderTypeServer, FolderTypeServerOpened),
  shared: folderIcon(FolderTypeShared, FolderTypeSharedOpened),
  source: folderIcon(FolderTypeSrc, FolderTypeSrcOpened),
  sources: folderIcon(FolderTypeSrc, FolderTypeSrcOpened),
  spec: folderIcon(FolderTypeTest, FolderTypeTestOpened),
  src: folderIcon(FolderTypeSrc, FolderTypeSrcOpened),
  "src-tauri": folderIcon(FolderTypeTauri, FolderTypeTauriOpened),
  static: folderIcon(FolderTypePublic, FolderTypePublicOpened),
  stories: folderIcon(FolderTypeStory, FolderTypeStoryOpened),
  story: folderIcon(FolderTypeStory, FolderTypeStoryOpened),
  storybook: folderIcon(FolderTypeStory, FolderTypeStoryOpened),
  style: folderIcon(FolderTypeStyle, FolderTypeStyleOpened),
  styles: folderIcon(FolderTypeStyle, FolderTypeStyleOpened),
  tauri: folderIcon(FolderTypeTauri, FolderTypeTauriOpened),
  temp: folderIcon(FolderTypeTemp, FolderTypeTempOpened),
  template: folderIcon(FolderTypeTemplate, FolderTypeTemplateOpened),
  templates: folderIcon(FolderTypeTemplate, FolderTypeTemplateOpened),
  test: folderIcon(FolderTypeTest, FolderTypeTestOpened),
  tests: folderIcon(FolderTypeTest, FolderTypeTestOpened),
  theme: folderIcon(FolderTypeTheme, FolderTypeThemeOpened),
  themes: folderIcon(FolderTypeTheme, FolderTypeThemeOpened),
  tmp: folderIcon(FolderTypeTemp, FolderTypeTempOpened),
  tool: folderIcon(FolderTypeTools, FolderTypeToolsOpened),
  tooling: folderIcon(FolderTypeTools, FolderTypeToolsOpened),
  tools: folderIcon(FolderTypeTools, FolderTypeToolsOpened),
  ts: folderIcon(FolderTypeTypescript, FolderTypeTypescriptOpened),
  types: folderIcon(FolderTypeTypings, FolderTypeTypingsOpened),
  typescript: folderIcon(FolderTypeTypescript, FolderTypeTypescriptOpened),
  typings: folderIcon(FolderTypeTypings, FolderTypeTypingsOpened),
  util: folderIcon(FolderTypeTools, FolderTypeToolsOpened),
  utilities: folderIcon(FolderTypeTools, FolderTypeToolsOpened),
  utils: folderIcon(FolderTypeTools, FolderTypeToolsOpened),
  video: folderIcon(FolderTypeVideo, FolderTypeVideoOpened),
  videos: folderIcon(FolderTypeVideo, FolderTypeVideoOpened),
  view: folderIcon(FolderTypeView, FolderTypeViewOpened),
  views: folderIcon(FolderTypeView, FolderTypeViewOpened),
  wasm: folderIcon(FolderTypeWasm, FolderTypeWasmOpened),
  web: folderIcon(FolderTypeWww, FolderTypeWwwOpened),
  webpack: folderIcon(FolderTypeWebpack, FolderTypeWebpackOpened),
  www: folderIcon(FolderTypeWww, FolderTypeWwwOpened),
};

const EXT_ICON: Record<string, IconSource> = {
  "7z": FileTypeZip,
  a: FileTypeBinary,
  aac: FileTypeAudio,
  apk: FileTypeZip,
  avi: FileTypeVideo,
  avif: FileTypeImage,
  bash: FileTypeShell,
  bin: FileTypeBinary,
  bmp: FileTypeImage,
  bz2: FileTypeZip,
  c: FileTypeC,
  cc: FileTypeCpp,
  cer: FileTypeCertificate,
  cert: FileTypeCertificate,
  cfg: FileTypeConfig,
  cjs: FileTypeJs,
  class: FileTypeBinary,
  cmake: FileTypeCmake,
  cmd: FileTypeBat,
  conf: FileTypeConfig,
  config: FileTypeConfig,
  cpp: FileTypeCpp,
  crt: FileTypeCertificate,
  cs: FileTypeCsharp,
  csr: FileTypeCertificate,
  css: FileTypeCss,
  csv: FileTypeExcel,
  cts: FileTypeTypescript,
  cxx: FileTypeCpp,
  "d.ts": FileTypeTsDef,
  dart: FileTypeDart,
  db: FileTypeSql,
  deb: FileTypeZip,
  dll: FileTypeBinary,
  dmg: FileTypeZip,
  doc: FileTypeWord,
  docx: FileTypeWord,
  dylib: FileTypeBinary,
  env: FileTypeConfig,
  eot: FileTypeFont,
  exe: FileTypeBinary,
  fish: FileTypeShell,
  flac: FileTypeAudio,
  gif: FileTypeImage,
  go: FileTypeGo,
  gql: FileTypeGraphql,
  gradle: FileTypeGradle,
  graphql: FileTypeGraphql,
  gz: FileTypeZip,
  h: FileTypeC,
  hpp: FileTypeCpp,
  htm: FileTypeHtml,
  html: FileTypeHtml,
  icns: FileTypeImage,
  ico: FileTypeImage,
  ini: FileTypeConfig,
  ipa: FileTypeZip,
  ipynb: FileTypePython,
  iso: FileTypeZip,
  jar: FileTypeZip,
  java: FileTypeJava,
  jpeg: FileTypeImage,
  jpg: FileTypeImage,
  js: FileTypeJs,
  json: FileTypeJson,
  json5: FileTypeJson,
  jsonc: FileTypeJson,
  jsx: FileTypeReactJs,
  key: FileTypeKey,
  ksh: FileTypeShell,
  kt: FileTypeKotlin,
  kts: FileTypeKotlin,
  less: FileTypeCss,
  lib: FileTypeBinary,
  lock: FileTypeLock,
  log: FileTypeLog,
  m4a: FileTypeAudio,
  markdown: FileTypeMarkdown,
  md: FileTypeMarkdown,
  mdx: FileTypeMarkdown,
  mjs: FileTypeJs,
  mkv: FileTypeVideo,
  mov: FileTypeVideo,
  mp3: FileTypeAudio,
  mp4: FileTypeVideo,
  mpeg: FileTypeVideo,
  mpg: FileTypeVideo,
  mts: FileTypeTypescript,
  node: FileTypeNode,
  o: FileTypeBinary,
  ogg: FileTypeAudio,
  opus: FileTypeAudio,
  otf: FileTypeFont,
  out: FileTypeLog,
  p12: FileTypeCertificate,
  pdf: FileTypePdf,
  pem: FileTypeCertificate,
  pfx: FileTypeCertificate,
  php: FileTypePhp,
  plist: FileTypeConfig,
  png: FileTypeImage,
  ppt: FileTypePowerpoint,
  pptx: FileTypePowerpoint,
  prisma: FileTypePrisma,
  properties: FileTypeConfig,
  ps1: FileTypePowershell,
  psd1: FileTypePowershell,
  psm1: FileTypePowershell,
  pub: FileTypeKey,
  py: FileTypePython,
  pyc: FileTypeBinary,
  pyi: FileTypePython,
  pyw: FileTypePython,
  rar: FileTypeZip,
  rb: FileTypeRuby,
  rpm: FileTypeZip,
  rs: FileTypeRust,
  rtf: FileTypeText,
  sass: FileTypeSass,
  scss: FileTypeSass,
  service: FileTypeSystemd,
  sh: FileTypeShell,
  so: FileTypeBinary,
  socket: FileTypeSystemd,
  sql: FileTypeSql,
  sqlite: FileTypeSql,
  sqlite3: FileTypeSql,
  svelte: FileTypeSvelte,
  svg: FileTypeSvg,
  swift: FileTypeSwift,
  tar: FileTypeZip,
  target: FileTypeSystemd,
  text: FileTypeText,
  tf: FileTypeTerraform,
  tfvars: FileTypeTerraform,
  tgz: FileTypeZip,
  timer: FileTypeSystemd,
  toml: FileTypeToml,
  ts: FileTypeTypescript,
  tsx: FileTypeReactTs,
  tsv: FileTypeExcel,
  ttf: FileTypeFont,
  txt: FileTypeText,
  vue: FileTypeVue,
  war: FileTypeZip,
  wasm: FileTypeBinary,
  wav: FileTypeAudio,
  webm: FileTypeVideo,
  webp: FileTypeImage,
  woff: FileTypeFont,
  woff2: FileTypeFont,
  xls: FileTypeExcel,
  xlsx: FileTypeExcel,
  xml: FileTypeXml,
  xz: FileTypeZip,
  yaml: FileTypeYaml,
  yml: FileTypeYaml,
  zip: FileTypeZip,
  zsh: FileTypeShell,
};

const EXT_ICON_SVG = {
  "7z": FileTypeZipSvg,
  a: FileTypeBinarySvg,
  aac: FileTypeAudioSvg,
  apk: FileTypeZipSvg,
  avi: FileTypeVideoSvg,
  avif: FileTypeImageSvg,
  bash: FileTypeShellSvg,
  bin: FileTypeBinarySvg,
  bmp: FileTypeImageSvg,
  bz2: FileTypeZipSvg,
  c: FileTypeCSvg,
  cc: FileTypeCppSvg,
  cer: FileTypeCertificateSvg,
  cert: FileTypeCertificateSvg,
  cfg: FileTypeConfigSvg,
  cjs: FileTypeJsSvg,
  class: FileTypeBinarySvg,
  cmake: FileTypeCmakeSvg,
  cmd: FileTypeBatSvg,
  conf: FileTypeConfigSvg,
  config: FileTypeConfigSvg,
  cpp: FileTypeCppSvg,
  crt: FileTypeCertificateSvg,
  cs: FileTypeCsharpSvg,
  csr: FileTypeCertificateSvg,
  css: FileTypeCssSvg,
  csv: FileTypeExcelSvg,
  cts: FileTypeTypescriptSvg,
  cxx: FileTypeCppSvg,
  "d.ts": FileTypeTsDefSvg,
  dart: FileTypeDartSvg,
  db: FileTypeSqlSvg,
  deb: FileTypeZipSvg,
  dll: FileTypeBinarySvg,
  dmg: FileTypeZipSvg,
  doc: FileTypeWordSvg,
  docx: FileTypeWordSvg,
  dylib: FileTypeBinarySvg,
  env: FileTypeConfigSvg,
  eot: FileTypeFontSvg,
  exe: FileTypeBinarySvg,
  fish: FileTypeShellSvg,
  flac: FileTypeAudioSvg,
  gif: FileTypeImageSvg,
  go: FileTypeGoSvg,
  gql: FileTypeGraphqlSvg,
  gradle: FileTypeGradleSvg,
  graphql: FileTypeGraphqlSvg,
  gz: FileTypeZipSvg,
  h: FileTypeCSvg,
  hpp: FileTypeCppSvg,
  htm: FileTypeHtmlSvg,
  html: FileTypeHtmlSvg,
  icns: FileTypeImageSvg,
  ico: FileTypeImageSvg,
  ini: FileTypeConfigSvg,
  ipa: FileTypeZipSvg,
  ipynb: FileTypePythonSvg,
  iso: FileTypeZipSvg,
  jar: FileTypeZipSvg,
  java: FileTypeJavaSvg,
  jpeg: FileTypeImageSvg,
  jpg: FileTypeImageSvg,
  js: FileTypeJsSvg,
  json: FileTypeJsonSvg,
  json5: FileTypeJsonSvg,
  jsonc: FileTypeJsonSvg,
  jsx: FileTypeReactJsSvg,
  key: FileTypeKeySvg,
  ksh: FileTypeShellSvg,
  kt: FileTypeKotlinSvg,
  kts: FileTypeKotlinSvg,
  less: FileTypeCssSvg,
  lib: FileTypeBinarySvg,
  lock: FileTypeLockSvg,
  log: FileTypeLogSvg,
  m4a: FileTypeAudioSvg,
  markdown: FileTypeMarkdownSvg,
  md: FileTypeMarkdownSvg,
  mdx: FileTypeMarkdownSvg,
  mjs: FileTypeJsSvg,
  mkv: FileTypeVideoSvg,
  mov: FileTypeVideoSvg,
  mp3: FileTypeAudioSvg,
  mp4: FileTypeVideoSvg,
  mpeg: FileTypeVideoSvg,
  mpg: FileTypeVideoSvg,
  mts: FileTypeTypescriptSvg,
  node: FileTypeNodeSvg,
  o: FileTypeBinarySvg,
  ogg: FileTypeAudioSvg,
  opus: FileTypeAudioSvg,
  otf: FileTypeFontSvg,
  out: FileTypeLogSvg,
  p12: FileTypeCertificateSvg,
  pdf: FileTypePdfSvg,
  pem: FileTypeCertificateSvg,
  pfx: FileTypeCertificateSvg,
  php: FileTypePhpSvg,
  plist: FileTypeConfigSvg,
  png: FileTypeImageSvg,
  ppt: FileTypePowerpointSvg,
  pptx: FileTypePowerpointSvg,
  prisma: FileTypePrismaSvg,
  properties: FileTypeConfigSvg,
  ps1: FileTypePowershellSvg,
  psd1: FileTypePowershellSvg,
  psm1: FileTypePowershellSvg,
  pub: FileTypeKeySvg,
  py: FileTypePythonSvg,
  pyc: FileTypeBinarySvg,
  pyi: FileTypePythonSvg,
  pyw: FileTypePythonSvg,
  rar: FileTypeZipSvg,
  rb: FileTypeRubySvg,
  rpm: FileTypeZipSvg,
  rs: FileTypeRustSvg,
  rtf: FileTypeTextSvg,
  sass: FileTypeSassSvg,
  scss: FileTypeSassSvg,
  service: FileTypeSystemdSvg,
  sh: FileTypeShellSvg,
  so: FileTypeBinarySvg,
  socket: FileTypeSystemdSvg,
  sql: FileTypeSqlSvg,
  sqlite: FileTypeSqlSvg,
  sqlite3: FileTypeSqlSvg,
  svelte: FileTypeSvelteSvg,
  svg: FileTypeSvgSvg,
  swift: FileTypeSwiftSvg,
  tar: FileTypeZipSvg,
  target: FileTypeSystemdSvg,
  text: FileTypeTextSvg,
  tf: FileTypeTerraformSvg,
  tfvars: FileTypeTerraformSvg,
  tgz: FileTypeZipSvg,
  timer: FileTypeSystemdSvg,
  toml: FileTypeTomlSvg,
  ts: FileTypeTypescriptSvg,
  tsx: FileTypeReactTsSvg,
  tsv: FileTypeExcelSvg,
  ttf: FileTypeFontSvg,
  txt: FileTypeTextSvg,
  vue: FileTypeVueSvg,
  war: FileTypeZipSvg,
  wasm: FileTypeBinarySvg,
  wav: FileTypeAudioSvg,
  webm: FileTypeVideoSvg,
  webp: FileTypeImageSvg,
  woff: FileTypeFontSvg,
  woff2: FileTypeFontSvg,
  xls: FileTypeExcelSvg,
  xlsx: FileTypeExcelSvg,
  xml: FileTypeXmlSvg,
  xz: FileTypeZipSvg,
  yaml: FileTypeYamlSvg,
  yml: FileTypeYamlSvg,
  zip: FileTypeZipSvg,
  zsh: FileTypeShellSvg,
} as unknown as Record<string, string>;

const NAME_ICON: Record<string, IconSource> = {
  ".bash_profile": FileTypeShell,
  ".bashrc": FileTypeShell,
  ".dockerignore": FileTypeDocker,
  ".editorconfig": FileTypeEditorConfig,
  ".env": FileTypeConfig,
  ".env.development": FileTypeConfig,
  ".env.local": FileTypeConfig,
  ".env.production": FileTypeConfig,
  ".eslintignore": FileTypeEslint,
  ".eslintrc": FileTypeEslint,
  ".gitattributes": FileTypeGit,
  ".gitconfig": FileTypeGit,
  ".gitignore": FileTypeGit,
  ".gitkeep": FileTypeGit,
  ".gitmodules": FileTypeGit,
  ".htaccess": FileTypeConfig,
  ".npmrc": FileTypeNpm,
  ".nvmrc": FileTypeNode,
  ".prettierrc": FileTypePrettier,
  ".prettierignore": FileTypePrettier,
  ".profile": FileTypeShell,
  ".vimrc": FileTypeConfig,
  ".yarnrc": FileTypeYarn,
  ".zprofile": FileTypeShell,
  ".zshrc": FileTypeShell,
  authorized_keys: FileTypeKey,
  "bun.lock": FileTypeBun,
  "bun.lockb": FileTypeBun,
  "cargo.lock": FileTypeRust,
  "cargo.toml": FileTypeRust,
  "cmakelists.txt": FileTypeCmake,
  "composer.json": FileTypePhp,
  "composer.lock": FileTypePhp,
  containerfile: FileTypeDocker,
  copying: FileTypeLicense,
  "copying.md": FileTypeLicense,
  "copying.txt": FileTypeLicense,
  "d.ts": FileTypeTsDef,
  "docker-compose.yaml": FileTypeDocker,
  "docker-compose.yml": FileTypeDocker,
  dockerfile: FileTypeDocker,
  "go.mod": FileTypeGoMod,
  "go.sum": FileTypeGoMod,
  "go.work": FileTypeGoMod,
  "go.work.sum": FileTypeGoMod,
  "gradle.properties": FileTypeGradle,
  gnumakefile: FileTypeMakefile,
  "httpd.conf": FileTypeConfig,
  id_dsa: FileTypeKey,
  id_ecdsa: FileTypeKey,
  id_ed25519: FileTypeKey,
  id_rsa: FileTypeKey,
  jenkinsfile: FileTypeConfig,
  "jsconfig.json": FileTypeJsConfig,
  known_hosts: FileTypeKey,
  license: FileTypeLicense,
  "license.md": FileTypeLicense,
  "license.txt": FileTypeLicense,
  makefile: FileTypeMakefile,
  "nginx.conf": FileTypeNginx,
  "package-lock.json": FileTypeNpm,
  "package.json": FileTypeNpm,
  "pnpm-lock.yaml": FileTypePnpm,
  "pnpm-workspace.yaml": FileTypePnpm,
  "pom.xml": FileTypeMaven,
  procfile: FileTypeConfig,
  "requirements.txt": FileTypePython,
  "resolv.conf": FileTypeConfig,
  "robots.txt": FileTypeText,
  "settings.gradle": FileTypeGradle,
  "settings.gradle.kts": FileTypeGradle,
  ssh_config: FileTypeKey,
  sshd_config: FileTypeKey,
  sudoers: FileTypeConfig,
  "tsconfig.json": FileTypeTsConfig,
  "yarn.lock": FileTypeYarn,
};

const NAME_ICON_SVG = {
  ".bash_profile": FileTypeShellSvg,
  ".bashrc": FileTypeShellSvg,
  ".dockerignore": FileTypeDockerSvg,
  ".editorconfig": FileTypeEditorConfigSvg,
  ".env": FileTypeConfigSvg,
  ".env.development": FileTypeConfigSvg,
  ".env.local": FileTypeConfigSvg,
  ".env.production": FileTypeConfigSvg,
  ".eslintignore": FileTypeEslintSvg,
  ".eslintrc": FileTypeEslintSvg,
  ".gitattributes": FileTypeGitSvg,
  ".gitconfig": FileTypeGitSvg,
  ".gitignore": FileTypeGitSvg,
  ".gitkeep": FileTypeGitSvg,
  ".gitmodules": FileTypeGitSvg,
  ".htaccess": FileTypeConfigSvg,
  ".npmrc": FileTypeNpmSvg,
  ".nvmrc": FileTypeNodeSvg,
  ".prettierrc": FileTypePrettierSvg,
  ".prettierignore": FileTypePrettierSvg,
  ".profile": FileTypeShellSvg,
  ".vimrc": FileTypeConfigSvg,
  ".yarnrc": FileTypeYarnSvg,
  ".zprofile": FileTypeShellSvg,
  ".zshrc": FileTypeShellSvg,
  authorized_keys: FileTypeKeySvg,
  "bun.lock": FileTypeBunSvg,
  "bun.lockb": FileTypeBunSvg,
  "cargo.lock": FileTypeRustSvg,
  "cargo.toml": FileTypeRustSvg,
  "cmakelists.txt": FileTypeCmakeSvg,
  "composer.json": FileTypePhpSvg,
  "composer.lock": FileTypePhpSvg,
  containerfile: FileTypeDockerSvg,
  copying: FileTypeLicenseSvg,
  "copying.md": FileTypeLicenseSvg,
  "copying.txt": FileTypeLicenseSvg,
  "d.ts": FileTypeTsDefSvg,
  "docker-compose.yaml": FileTypeDockerSvg,
  "docker-compose.yml": FileTypeDockerSvg,
  dockerfile: FileTypeDockerSvg,
  "go.mod": FileTypeGoModSvg,
  "go.sum": FileTypeGoModSvg,
  "go.work": FileTypeGoModSvg,
  "go.work.sum": FileTypeGoModSvg,
  "gradle.properties": FileTypeGradleSvg,
  gnumakefile: FileTypeMakefileSvg,
  "httpd.conf": FileTypeConfigSvg,
  id_dsa: FileTypeKeySvg,
  id_ecdsa: FileTypeKeySvg,
  id_ed25519: FileTypeKeySvg,
  id_rsa: FileTypeKeySvg,
  jenkinsfile: FileTypeConfigSvg,
  "jsconfig.json": FileTypeJsConfigSvg,
  known_hosts: FileTypeKeySvg,
  license: FileTypeLicenseSvg,
  "license.md": FileTypeLicenseSvg,
  "license.txt": FileTypeLicenseSvg,
  makefile: FileTypeMakefileSvg,
  "nginx.conf": FileTypeNginxSvg,
  "package-lock.json": FileTypeNpmSvg,
  "package.json": FileTypeNpmSvg,
  "pnpm-lock.yaml": FileTypePnpmSvg,
  "pnpm-workspace.yaml": FileTypePnpmSvg,
  "pom.xml": FileTypeMavenSvg,
  procfile: FileTypeConfigSvg,
  "requirements.txt": FileTypePythonSvg,
  "resolv.conf": FileTypeConfigSvg,
  "robots.txt": FileTypeTextSvg,
  "settings.gradle": FileTypeGradleSvg,
  "settings.gradle.kts": FileTypeGradleSvg,
  ssh_config: FileTypeKeySvg,
  sshd_config: FileTypeKeySvg,
  sudoers: FileTypeConfigSvg,
  "tsconfig.json": FileTypeTsConfigSvg,
  "yarn.lock": FileTypeYarnSvg,
} as unknown as Record<string, string>;

const PREFIX_ICON: Array<[string, IconSource]> = [
  [".env", FileTypeConfig],
  [".eslintrc", FileTypeEslint],
  [".git", FileTypeGit],
  [".npmrc", FileTypeNpm],
  [".prettierrc", FileTypePrettier],
  [".yarnrc", FileTypeYarn],
  ["compose.", FileTypeDocker],
  ["docker-compose.", FileTypeDocker],
  ["eslint.config.", FileTypeEslint],
  ["prettier.config.", FileTypePrettier],
  ["vite.config.", FileTypeVite],
  ["vitest.config.", FileTypeVitest],
  ["webpack.config.", FileTypeWebpack],
];

const PREFIX_ICON_SVG: Array<[string, string]> = [
  [".env", FileTypeConfigSvg],
  [".eslintrc", FileTypeEslintSvg],
  [".git", FileTypeGitSvg],
  [".npmrc", FileTypeNpmSvg],
  [".prettierrc", FileTypePrettierSvg],
  [".yarnrc", FileTypeYarnSvg],
  ["compose.", FileTypeDockerSvg],
  ["docker-compose.", FileTypeDockerSvg],
  ["eslint.config.", FileTypeEslintSvg],
  ["prettier.config.", FileTypePrettierSvg],
  ["vite.config.", FileTypeViteSvg],
  ["vitest.config.", FileTypeVitestSvg],
  ["webpack.config.", FileTypeWebpackSvg],
] as unknown as Array<[string, string]>;

function lastSegment(path: string) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function extOf(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function compoundExtOf(name: string) {
  const parts = name.split(".");
  if (parts.length < 3) return "";
  return parts.slice(-2).join(".").toLowerCase();
}

function getFolderTypeIcon(path: string, expanded?: boolean) {
  const name = lastSegment(path).toLowerCase();
  const icon = FOLDER_ICON[name] ?? DEFAULT_FOLDER_ICON;
  return expanded ? icon.opened : icon.closed;
}

export function getFileTypeIcon(
  path: string,
  kind: "file" | "dir",
  options?: FileTypeIconOptions,
): IconSource {
  if (kind === "dir") return getFolderTypeIcon(path, options?.expanded);
  const name = lastSegment(path).toLowerCase();
  const byName = NAME_ICON[name];
  if (byName) return byName;
  const byPrefix = PREFIX_ICON.find(([prefix]) => name.startsWith(prefix));
  if (byPrefix) return byPrefix[1];
  const compoundExt = compoundExtOf(name);
  if (compoundExt && EXT_ICON[compoundExt]) return EXT_ICON[compoundExt];
  const ext = extOf(name);
  if (ext && EXT_ICON[ext]) return EXT_ICON[ext];
  return DefaultFile;
}

export function getFileTypeIconSvg(path: string, kind: "file" | "dir"): string {
  if (kind === "dir") return DefaultFolderSvg as unknown as string;
  const name = lastSegment(path).toLowerCase();
  const byName = NAME_ICON_SVG[name];
  if (byName) return byName;
  const byPrefix = PREFIX_ICON_SVG.find(([prefix]) => name.startsWith(prefix));
  if (byPrefix) return byPrefix[1];
  const compoundExt = compoundExtOf(name);
  if (compoundExt && EXT_ICON_SVG[compoundExt]) return EXT_ICON_SVG[compoundExt];
  const ext = extOf(name);
  if (ext && EXT_ICON_SVG[ext]) return EXT_ICON_SVG[ext];
  return DefaultFileSvg as unknown as string;
}

export type FileTypeIconComponent = IconSource;

// Uploaded-attachment icon: extension wins; a bare name (no extension) falls
// back through the upload pipeline's detected kind so a PDF picked without
// ".pdf" still gets the PDF glyph. Structural param keeps this file identical
// on both ends despite their different PendingUploadedFile import paths.
const UPLOAD_KIND_FALLBACK_FILENAME: Record<string, string> = {
  text: "file.txt",
  image: "file.png",
  pdf: "file.pdf",
  notebook: "file.ipynb",
  word: "file.docx",
  spreadsheet: "file.xlsx",
  archive: "file.zip",
};

export function getUploadedFileTypeIcon(file: { fileName: string; kind: string }): IconSource {
  const name = file.fileName.trim();
  if (/\.[^./\\]+$/.test(name)) return getFileTypeIcon(name, "file");
  return getFileTypeIcon(UPLOAD_KIND_FALLBACK_FILENAME[file.kind] ?? "file.txt", "file");
}
