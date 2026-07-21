import { type ComponentType, type SVGProps, useId } from "react";
import McpLogoSource from "~icons/gravity-ui/logo-mcp";
import ConnectionIconSource from "~icons/gravity-ui/plug-connection";
import ClaudeSource from "~icons/logos/claude-icon";
import OpenAISource from "~icons/logos/openai-icon";
import ActivitySource from "~icons/lucide/activity";
import ArchiveSource from "~icons/lucide/archive";
import ArchiveRestoreSource from "~icons/lucide/archive-restore";
import ArrowLeftSource from "~icons/lucide/arrow-left";
import BanSource from "~icons/lucide/ban";
import BlendSource from "~icons/lucide/blend";
import BookOpenSource from "~icons/lucide/book-open";
import BotSource from "~icons/lucide/bot";
import BrainSource from "~icons/lucide/brain";
import BrushCleaningSource from "~icons/lucide/brush-cleaning";
import CableSource from "~icons/lucide/cable";
import CheckSource from "~icons/lucide/check";
import ChevronDownSource from "~icons/lucide/chevron-down";
import ChevronRightSource from "~icons/lucide/chevron-right";
import ChevronUpSource from "~icons/lucide/chevron-up";
import CircleSource from "~icons/lucide/circle";
import CheckCircle2Source from "~icons/lucide/circle-check";
import CircleHelpSource from "~icons/lucide/circle-help";
import CirclePlusSource from "~icons/lucide/circle-plus";
import XCircleSource from "~icons/lucide/circle-x";
import ClipboardPasteSource from "~icons/lucide/clipboard-paste";
import Clock3Source from "~icons/lucide/clock-3";
import CloudSource from "~icons/lucide/cloud";
import CloudDownloadSource from "~icons/lucide/cloud-download";
import CopySource from "~icons/lucide/copy";
import CpuSource from "~icons/lucide/cpu";
import TargetSource from "~icons/lucide/crosshair";
import DownloadSource from "~icons/lucide/download";
import Globe2Source from "~icons/lucide/earth";
import MoreHorizontalSource from "~icons/lucide/ellipsis";
import ExternalLinkSource from "~icons/lucide/external-link";
import EyeSource from "~icons/lucide/eye";
import EyeOffSource from "~icons/lucide/eye-off";
import FileSource from "~icons/lucide/file";
import FilePenLineSource from "~icons/lucide/file-pen-line";
import FileTextSource from "~icons/lucide/file-text";
import FolderSource from "~icons/lucide/folder";
import FolderClosedSource from "~icons/lucide/folder-closed";
import FolderOpenSource from "~icons/lucide/folder-open";
import FolderTreeSource from "~icons/lucide/folder-tree";
import GitBranchSource from "~icons/lucide/git-branch";
import GitCommitHorizontalSource from "~icons/lucide/git-commit-horizontal";
import GithubSource from "~icons/lucide/github";
import GlobeSource from "~icons/lucide/globe";
import GlobeOffSource from "~icons/lucide/globe-off";
import GripVerticalSource from "~icons/lucide/grip-vertical";
import HistorySource from "~icons/lucide/history";
import HouseSource from "~icons/lucide/house";
import ImageIconSource from "~icons/lucide/image";
import ImageOffSource from "~icons/lucide/image-off";
import InfoSource from "~icons/lucide/info";
import KeySource from "~icons/lucide/key";
import LayersSource from "~icons/lucide/layers";
import LayoutGridSource from "~icons/lucide/layout-grid";
import LightbulbSource from "~icons/lucide/lightbulb";
import LightbulbOffSource from "~icons/lucide/lightbulb-off";
import Link2Source from "~icons/lucide/link-2";
import ListSource from "~icons/lucide/list";
import ListChecksSource from "~icons/lucide/list-checks";
import Loader2Source from "~icons/lucide/loader-circle";
import LoaderCircleSource from "~icons/lucide/loader-circle";
import LockSource from "~icons/lucide/lock";
import LogOutSource from "~icons/lucide/log-out";
import Maximize2Source from "~icons/lucide/maximize-2";
import MessageCircleSource from "~icons/lucide/message-circle";
import MessageSquareSource from "~icons/lucide/message-square";
import MessageSquareTextSource from "~icons/lucide/message-square-text";
import Minimize2Source from "~icons/lucide/minimize-2";
import MinusSource from "~icons/lucide/minus";
import MonitorSmartphoneSource from "~icons/lucide/monitor-smartphone";
import MoonSource from "~icons/lucide/moon";
import PackageSource from "~icons/lucide/package";
import PaletteSource from "~icons/lucide/palette";
import PanelLeftSource from "~icons/lucide/panel-left";
import PanelLeftCloseSource from "~icons/lucide/panel-left-close";
import PanelRightCloseSource from "~icons/lucide/panel-right-close";
import PanelRightOpenSource from "~icons/lucide/panel-right-open";
import PaperclipSource from "~icons/lucide/paperclip";
import Edit3Source from "~icons/lucide/pen-line";
import PencilSource from "~icons/lucide/pencil";
import PinSource from "~icons/lucide/pin";
import PinOffSource from "~icons/lucide/pin-off";
import PlaySource from "~icons/lucide/play";
import PlugSource from "~icons/lucide/plug";
import PlusSource from "~icons/lucide/plus";
import RadioSource from "~icons/lucide/radio";
import Redo2Source from "~icons/lucide/redo-2";
import RefreshCwSource from "~icons/lucide/refresh-cw";
import ReplaceSource from "~icons/lucide/replace";
import RotateCwSquareSource from "~icons/lucide/rotate-cw-square";
import SaveSource from "~icons/lucide/save";
import ScanTextSource from "~icons/lucide/scan-text";
import ScissorsSource from "~icons/lucide/scissors";
import ScrollTextSource from "~icons/lucide/scroll-text";
import SearchSource from "~icons/lucide/search";
import SendSource from "~icons/lucide/send";
import ServerSource from "~icons/lucide/server";
import SettingsSource from "~icons/lucide/settings";
import Settings2Source from "~icons/lucide/settings-2";
import Share2Source from "~icons/lucide/share-2";
import ShieldSource from "~icons/lucide/shield";
import SparkleSource from "~icons/lucide/sparkle";
import SparklesSource from "~icons/lucide/sparkles";
import SquareSource from "~icons/lucide/square";
import SquarePenSource from "~icons/lucide/square-pen";
import SunSource from "~icons/lucide/sun";
import TagSource from "~icons/lucide/tag";
import TerminalSource from "~icons/lucide/terminal";
import TextSelectSource from "~icons/lucide/text-select";
import TimerSource from "~icons/lucide/timer";
import Trash2Source from "~icons/lucide/trash-2";
import AlertTriangleSource from "~icons/lucide/triangle-alert";
import Undo2Source from "~icons/lucide/undo-2";
import UploadSource from "~icons/lucide/upload";
import WalletSource from "~icons/lucide/wallet";
import WaypointsSource from "~icons/lucide/waypoints";
import WifiSource from "~icons/lucide/wifi";
import WifiOffSource from "~icons/lucide/wifi-off";
import WrenchSource from "~icons/lucide/wrench";
import XSource from "~icons/lucide/x";
import ZapSource from "~icons/lucide/zap";

type IconSource = ComponentType<SVGProps<SVGSVGElement> & { title?: string }>;

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  title?: string;
};

export type IconComponent = ComponentType<IconProps>;

function createIcon(Source: IconSource): IconComponent {
  return function Icon({ height, size, width, ...props }) {
    const nextProps: IconProps = { ...props };
    if (size !== undefined) {
      nextProps.width = width ?? size;
      nextProps.height = height ?? size;
    } else {
      if (width !== undefined) nextProps.width = width;
      if (height !== undefined) nextProps.height = height;
    }
    return <Source {...nextProps} />;
  };
}

const skillIconOuterPath = `M8102 20439 c-298 -35 -568 -170 -777 -390 -175 -183 -288 -406 -337
-667 -10 -54 -13 -1300 -13 -6347 0 -6030 1 -6283 18 -6365 74 -347 266 -634
550 -822 144 -95 269 -147 459 -191 92 -21 104 -21 1808 -26 l1715 -6 3690
-692 c2030 -381 3733 -698 3785 -704 123 -15 276 -5 411 25 480 109 863 496
963 973 58 275 2269 12123 2278 12207 14 129 0 295 -36 437 -105 413 -439 766
-844 893 -46 14 -928 184 -1960 376 -1032 193 -1883 354 -1891 358 -7 4 -28
49 -46 100 -127 355 -420 649 -773 776 -39 14 -116 36 -170 48 l-97 23 -4330
1 c-2381 1 -4363 -2 -4403 -7z m8810 -500 c298 -102 510 -345 557 -640 15 -88
15 -12428 1 -12517 -16 -95 -67 -226 -121 -306 -92 -138 -236 -256 -378 -311
-156 -59 188 -55 -4538 -53 l-4328 3 -73 23 c-295 91 -499 310 -569 608 -17
76 -18 289 -18 6299 l0 6220 22 86 c49 194 143 339 295 456 91 69 225 130 339
152 25 5 1953 8 4389 7 l4345 -1 77 -26z m2838 -1269 c971 -181 1794 -337
1830 -345 151 -37 328 -150 426 -273 62 -78 139 -240 159 -335 38 -176 115
256 -1119 -6332 -619 -3311 -1138 -6060 -1152 -6110 -62 -220 -207 -392 -419
-495 -207 -100 -314 -104 -730 -27 -159 30 -1273 238 -2475 463 l-2184 409
926 3 927 2 1473 -276 c810 -152 1507 -278 1548 -281 258 -17 513 150 615 404
28 68 2223 11780 2232 11903 18 269 -170 541 -431 624 -45 15 -824 165 -1741
336 -913 170 -1666 312 -1672 315 -10 3 -13 48 -13 175 0 157 1 170 18 170 10
0 812 -148 1782 -330z m-112 -575 c908 -170 1658 -315 1690 -327 42 -16 74
-38 123 -87 73 -73 105 -140 115 -240 5 -47 -165 -970 -1091 -5916 -603 -3223
-1100 -5879 -1106 -5903 -26 -116 -102 -213 -212 -267 -130 -64 -83 -70 -1187
138 l-974 184 84 27 c189 63 352 165 501 315 195 195 309 413 354 675 13 79
15 733 15 5903 l0 5815 28 -6 c15 -3 762 -143 1660 -311z`;

const skillIconInnerPath = `M8340 19620 c-138 -18 -292 -99 -385 -202 -54 -60 -104 -148 -137
-238 l-23 -65 -3 -6035 c-2 -5476 -1 -6042 13 -6114 49 -242 221 -424 465
-493 62 -17 225 -18 4180 -18 3369 0 4127 2 4180 13 181 37 358 175 438 342
22 47 45 109 51 138 16 75 16 12109 0 12184 -15 71 -79 202 -128 261 -84 100
-199 176 -328 214 -55 17 -281 18 -4163 19 -2258 1 -4130 -2 -4160 -6z m8231
-240 c122 -23 228 -105 283 -220 l31 -65 0 -6055 0 -6055 -28 -60 c-56 -119
-171 -205 -304 -225 -47 -7 -1349 -10 -4133 -8 -3755 3 -4069 4 -4113 20 -114
39 -204 125 -249 235 l-23 58 -3 6005 c-2 4516 0 6019 9 6060 32 155 156 279
311 309 64 13 8152 13 8219 1z`;

const skillIconStarPath = `M11967 15673 l-495 -858 -1021 -3 c-562 -1 -1021 -4 -1021 -6 0 -3
983 -1708 1005 -1742 13 -20 -26 -90 -496 -904 -280 -485 -509 -884 -509 -886
0 -2 460 -5 1021 -6 l1022 -3 491 -852 c270 -469 495 -851 500 -850 4 2 229
386 500 855 l491 852 1021 2 1022 3 -510 883 -510 883 510 882 509 882 -1018
3 -1019 2 -23 38 c-13 20 -237 406 -497 857 -260 451 -474 821 -475 823 -1 1
-225 -383 -498 -855z m732 -501 c112 -194 201 -355 199 -358 -3 -2 -201 -3
-441 -2 l-436 3 221 383 220 383 17 -28 c10 -15 109 -187 220 -381z m-1509
-839 c0 -17 -466 -811 -472 -805 -8 8 -468 803 -468 808 0 2 212 4 470 4 259
0 470 -3 470 -7z m2366 -645 l374 -647 -374 -648 -374 -648 -719 -2 -718 -2
-369 641 c-204 353 -370 649 -370 657 -1 9 166 305 369 658 l370 643 719 -3
718 -2 374 -647z m1097 604 c-16 -26 -122 -211 -237 -410 -115 -199 -213 -359
-217 -355 -5 6 -200 343 -466 806 -2 4 210 7 472 7 l475 0 -27 -48z m-3686
-2152 l229 -395 -470 -3 c-258 -1 -471 -1 -473 2 -3 3 407 721 454 795 12 19
17 21 24 10 4 -8 111 -192 236 -409z m3478 8 l233 -403 -233 -3 c-129 -1 -342
-1 -474 0 l-241 3 211 365 c116 201 222 384 236 408 13 24 27 41 30 38 3 -3
110 -187 238 -408z m-1548 -892 c-3 -8 -98 -173 -210 -368 -112 -194 -208
-361 -214 -371 -8 -15 -45 42 -213 335 -112 194 -212 368 -223 386 l-19 32
442 0 c377 0 441 -2 437 -14z`;

function SkillIconSource({ title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      {...props}
      version="1.0"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="620 505 1725 1725"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden={title ? undefined : true}
    >
      <title>{title ?? "Skill"}</title>
      <g transform="translate(0,2600) scale(0.1,-0.1)" fill="currentColor" stroke="none">
        <path d={skillIconOuterPath} />
        <path d={skillIconInnerPath} />
        <path d={skillIconStarPath} />
      </g>
    </svg>
  );
}

/** Raw markup mirror of SkillIconSource, for imperative DOM builders (e.g. mention chips). */
export const SKILL_ICON_SVG_MARKUP = `<svg viewBox="620 505 1725 1725" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><g transform="translate(0,2600) scale(0.1,-0.1)" fill="currentColor" stroke="none"><path d="${skillIconOuterPath}"/><path d="${skillIconInnerPath}"/><path d="${skillIconStarPath}"/></g></svg>`;

function GeminiIconSource({ title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  const idPrefix = `gemini-${useId().replaceAll(":", "")}`;
  const shapeId = `${idPrefix}-shape`;
  const maskId = `${idPrefix}-mask`;
  const filterYellowId = `${idPrefix}-yellow`;
  const filterRedGlowId = `${idPrefix}-red-glow`;
  const filterGreenId = `${idPrefix}-green`;
  const filterBlueId = `${idPrefix}-blue`;
  const filterGoldId = `${idPrefix}-gold`;
  const filterBlueAccentId = `${idPrefix}-blue-accent`;
  const filterSkyId = `${idPrefix}-sky`;
  const filterRedId = `${idPrefix}-red`;
  const filterYellowAccentId = `${idPrefix}-yellow-accent`;

  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 32 32"
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={title ? undefined : true}
    >
      <title>{title ?? "Gemini"}</title>
      <path d="M0 0h32v32H0z" fill="none" />
      <defs>
        <path
          id={shapeId}
          fill="#fff"
          d="M57.067 28.61q-7.396-3.184-12.945-8.732q-5.547-5.546-8.732-12.944a38.4 38.4 0 0 1-1.97-5.824A1.464 1.464 0 0 0 32 .001c-.671 0-1.255.458-1.419 1.11a38.4 38.4 0 0 1-1.971 5.823q-3.186 7.397-8.732 12.944q-5.548 5.548-12.945 8.732a38.4 38.4 0 0 1-5.824 1.972A1.464 1.464 0 0 0 0 32c0 .67.458 1.255 1.11 1.418a38.4 38.4 0 0 1 5.823 1.972q7.396 3.184 12.945 8.732q5.55 5.546 8.732 12.944a38.4 38.4 0 0 1 1.971 5.824c.164.65.749 1.11 1.419 1.11s1.255-.458 1.419-1.11a38.4 38.4 0 0 1 1.971-5.823q3.185-7.395 8.732-12.944q5.548-5.548 12.945-8.732a38.4 38.4 0 0 1 5.824-1.972A1.464 1.464 0 0 0 64 32.001c0-.672-.458-1.255-1.11-1.42a38.4 38.4 0 0 1-5.823-1.97"
        />
      </defs>
      <g fill="none">
        <g mask={`url(#${maskId})`} transform="translate(2 2)scale(.4375)">
          <use href={`#${shapeId}`} />
          <g filter={`url(#${filterYellowId})`}>
            <ellipse
              cx="14.208"
              cy="16.716"
              fill="#ffe432"
              rx="14.208"
              ry="16.716"
              transform="rotate(19.552 -43.96 -16.268)"
            />
          </g>
          <g filter={`url(#${filterRedGlowId})`}>
            <ellipse cx="27.054" cy="2.551" fill="#fc413d" rx="18.394" ry="18.799" />
          </g>
          <g filter={`url(#${filterGreenId})`}>
            <ellipse
              cx="19.224"
              cy="24.904"
              fill="#00b95c"
              rx="19.224"
              ry="24.904"
              transform="rotate(-2.799 667.58 51.694)"
            />
          </g>
          <g filter={`url(#${filterGreenId})`}>
            <ellipse
              cx="18.843"
              cy="20.744"
              fill="#00b95c"
              rx="18.843"
              ry="20.744"
              transform="rotate(-31.317 81.174 36.482)"
            />
          </g>
          <g filter={`url(#${filterBlueId})`}>
            <ellipse cx="66.462" cy="24.977" fill="#3186ff" rx="18.093" ry="17.423" />
          </g>
          <g filter={`url(#${filterGoldId})`}>
            <ellipse
              cx="20.929"
              cy="22.075"
              fill="#fbbc04"
              rx="20.929"
              ry="22.075"
              transform="rotate(37.251 9.618 -7.898)"
            />
          </g>
          <g filter={`url(#${filterBlueAccentId})`}>
            <ellipse
              cx="24.131"
              cy="22.292"
              fill="#3186ff"
              rx="24.131"
              ry="22.292"
              transform="rotate(34.51 19.317 63.957)"
            />
          </g>
          <g filter={`url(#${filterSkyId})`}>
            <path
              fill="#749bff"
              d="M54.226-2.304c2.794 3.799-.797 11.184-8.02 16.497c-7.222 5.312-15.342 6.539-18.136 2.74S28.866 5.75 36.09.436c7.223-5.312 15.343-6.539 18.136-2.74"
            />
          </g>
          <g filter={`url(#${filterRedId})`}>
            <ellipse
              cx="27.585"
              cy="17.148"
              fill="#fc413d"
              rx="27.585"
              ry="17.148"
              transform="rotate(-42.847 5.973 20.37)"
            />
          </g>
          <g filter={`url(#${filterYellowAccentId})`}>
            <ellipse
              cx="14.782"
              cy="8.596"
              fill="#ffee48"
              rx="14.782"
              ry="8.596"
              transform="rotate(35.592 -44.338 25.191)"
            />
          </g>
        </g>
        <defs>
          <filter
            id={filterYellowId}
            width="38.868"
            height="42.756"
            x="-19.618"
            y="12.903"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="2.46" />
          </filter>
          <filter
            id={filterRedGlowId}
            width="84.353"
            height="85.162"
            x="-15.122"
            y="-40.03"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="11.891" />
          </filter>
          <filter
            id={filterGreenId}
            width="78.916"
            height="90.22"
            x="-20.768"
            y="11.483"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="10.109" />
          </filter>
          <filter
            id={filterBlueId}
            width="74.611"
            height="73.27"
            x="29.156"
            y="-11.658"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="9.606" />
          </filter>
          <filter
            id={filterGoldId}
            width="77.538"
            height="78.151"
            x="-38.291"
            y="-16.269"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="8.706" />
          </filter>
          <filter
            id={filterBlueAccentId}
            width="78.218"
            height="76.898"
            x="7.78"
            y="-6.098"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="7.775" />
          </filter>
          <filter
            id={filterSkyId}
            width="55.879"
            height="51.479"
            x="13.208"
            y="-18.425"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="6.957" />
          </filter>
          <filter
            id={filterRedId}
            width="70.203"
            height="68.674"
            x="-15.474"
            y="-31.027"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="5.876" />
          </filter>
          <filter
            id={filterYellowAccentId}
            width="55.137"
            height="51.261"
            x="-14.173"
            y="20.474"
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
          >
            <feGaussianBlur stdDeviation="7.273" />
          </filter>
          <mask id={maskId} width="64" height="64" x="0" y="0" maskUnits="userSpaceOnUse">
            <use href={`#${shapeId}`} />
          </mask>
        </defs>
      </g>
    </svg>
  );
}

export const AlertTriangle = createIcon(AlertTriangleSource);
export const ClaudeIcon = createIcon(ClaudeSource);
export const GeminiIcon = createIcon(GeminiIconSource);
export const Archive = createIcon(ArchiveSource);
export const ArchiveRestore = createIcon(ArchiveRestoreSource);
export const ArrowLeft = createIcon(ArrowLeftSource);
export const Activity = createIcon(ActivitySource);
export const Ban = createIcon(BanSource);
export const Blend = createIcon(BlendSource);
export const BookOpen = createIcon(BookOpenSource);
export const Bot = createIcon(BotSource);
export const Brain = createIcon(BrainSource);
export const BrushCleaning = createIcon(BrushCleaningSource);
export const Cable = createIcon(CableSource);
export const Check = createIcon(CheckSource);
export const CheckCircle2 = createIcon(CheckCircle2Source);
export const ChevronDown = createIcon(ChevronDownSource);
export const ChevronRight = createIcon(ChevronRightSource);
export const ChevronUp = createIcon(ChevronUpSource);
export const Circle = createIcon(CircleSource);
export const CircleHelp = createIcon(CircleHelpSource);
export const CirclePlus = createIcon(CirclePlusSource);
export const ClipboardPaste = createIcon(ClipboardPasteSource);
export const Clock3 = createIcon(Clock3Source);
export const Cloud = createIcon(CloudSource);
export const CloudDownload = createIcon(CloudDownloadSource);
export const ConnectionIcon = createIcon(ConnectionIconSource);
export const Copy = createIcon(CopySource);
export const Cpu = createIcon(CpuSource);
export const Download = createIcon(DownloadSource);
export const Edit3 = createIcon(Edit3Source);
export const ExternalLink = createIcon(ExternalLinkSource);
export const Eye = createIcon(EyeSource);
export const EyeOff = createIcon(EyeOffSource);
export const File = createIcon(FileSource);
export const FilePenLine = createIcon(FilePenLineSource);
export const FileText = createIcon(FileTextSource);
export const Folder = createIcon(FolderSource);
export const FolderClosed = createIcon(FolderClosedSource);
export const FolderOpen = createIcon(FolderOpenSource);
export const FolderTree = createIcon(FolderTreeSource);
export const Globe = createIcon(GlobeSource);
export const Globe2 = createIcon(Globe2Source);
export const GlobeOff = createIcon(GlobeOffSource);
export const GitBranch = createIcon(GitBranchSource);
export const GitCommitHorizontal = createIcon(GitCommitHorizontalSource);
export const Github = createIcon(GithubSource);
export const GripVertical = createIcon(GripVerticalSource);
export const History = createIcon(HistorySource);
export const House = createIcon(HouseSource);
export const ImageIcon = createIcon(ImageIconSource);
export const ImageOff = createIcon(ImageOffSource);
export const Info = createIcon(InfoSource);
export const Key = createIcon(KeySource);
export const Layers = createIcon(LayersSource);
export const LayoutGrid = createIcon(LayoutGridSource);
export const Link2 = createIcon(Link2Source);
export const Lightbulb = createIcon(LightbulbSource);
export const LightbulbOff = createIcon(LightbulbOffSource);
export const List = createIcon(ListSource);
export const ListChecks = createIcon(ListChecksSource);
export const Loader2 = createIcon(Loader2Source);
export const LoaderCircle = createIcon(LoaderCircleSource);
export const Lock = createIcon(LockSource);
export const LogOut = createIcon(LogOutSource);
export const Maximize2 = createIcon(Maximize2Source);
export const MessageCircle = createIcon(MessageCircleSource);
export const MessageSquare = createIcon(MessageSquareSource);
export const MessageSquareText = createIcon(MessageSquareTextSource);
export const McpLogo = createIcon(McpLogoSource);
export const Minimize2 = createIcon(Minimize2Source);
export const Minus = createIcon(MinusSource);
export const MonitorSmartphone = createIcon(MonitorSmartphoneSource);
export const Moon = createIcon(MoonSource);
export const MoreHorizontal = createIcon(MoreHorizontalSource);
export const OpenaiChatgptIcon = createIcon(OpenAISource);
export const PanelLeft = createIcon(PanelLeftSource);
export const PanelLeftClose = createIcon(PanelLeftCloseSource);
export const PanelRightClose = createIcon(PanelRightCloseSource);
export const PanelRightOpen = createIcon(PanelRightOpenSource);
export const Paperclip = createIcon(PaperclipSource);
export const Pencil = createIcon(PencilSource);
export const Package = createIcon(PackageSource);
export const Palette = createIcon(PaletteSource);
export const Pin = createIcon(PinSource);
export const PinOff = createIcon(PinOffSource);
export const Play = createIcon(PlaySource);
export const Plug = createIcon(PlugSource);
export const Plus = createIcon(PlusSource);
export const Radio = createIcon(RadioSource);
export const Redo2 = createIcon(Redo2Source);
export const RefreshCw = createIcon(RefreshCwSource);
export const Replace = createIcon(ReplaceSource);
export const RotateCwSquare = createIcon(RotateCwSquareSource);
export const Save = createIcon(SaveSource);
export const ScanText = createIcon(ScanTextSource);
export const ScrollText = createIcon(ScrollTextSource);
export const Scissors = createIcon(ScissorsSource);
export const Search = createIcon(SearchSource);
export const Send = createIcon(SendSource);
export const Server = createIcon(ServerSource);
export const Settings = createIcon(SettingsSource);
export const Settings2 = createIcon(Settings2Source);
export const Share2 = createIcon(Share2Source);
export const Shield = createIcon(ShieldSource);
export const SkillIcon = createIcon(SkillIconSource);
export const Sparkle = createIcon(SparkleSource);
export const Sparkles = createIcon(SparklesSource);
export const Square = createIcon(SquareSource);
export const SquarePen = createIcon(SquarePenSource);
export const Sun = createIcon(SunSource);
export const Tag = createIcon(TagSource);
export const Target = createIcon(TargetSource);
export const Terminal = createIcon(TerminalSource);
export const TextSelect = createIcon(TextSelectSource);
export const Timer = createIcon(TimerSource);
export const Trash2 = createIcon(Trash2Source);
export const Undo2 = createIcon(Undo2Source);
export const Upload = createIcon(UploadSource);
export const Wallet = createIcon(WalletSource);
export const Waypoints = createIcon(WaypointsSource);
export const Wifi = createIcon(WifiSource);
export const WifiOff = createIcon(WifiOffSource);
export const Wrench = createIcon(WrenchSource);
export const X = createIcon(XSource);
export const XCircle = createIcon(XCircleSource);
export const Zap = createIcon(ZapSource);
