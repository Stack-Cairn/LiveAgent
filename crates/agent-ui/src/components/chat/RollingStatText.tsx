import { useEffect, useState } from "react";

const DIGITS = Array.from({ length: 10 }, (_, digit) => digit);

/** 单位、标点和标签留在原位；每一位数字独立滚动，右侧位数身份保持稳定。 */
function RollingDigit({ digit }: { digit: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <span className="stat-digit-window" aria-hidden="true">
      <span
        className={ready ? "stat-digit-strip stat-digit-ready" : "stat-digit-strip"}
        style={{ transform: `translateY(-${Number(digit)}em)` }}
        data-current-digit={digit}
      >
        {DIGITS.map((value) => (
          <span className="stat-digit-cell" data-digit={value} key={value} />
        ))}
      </span>
    </span>
  );
}

export function RollingStatText({ text }: { text: string }) {
  return (
    <span className="stat-rolling-text">
      {text.split(/(\d+)/).map((part, index) =>
        /^\d+$/.test(part) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 固定格式中的数字槽位必须跨读数更新保留身份。
          <span className="stat-number" key={`number-${index}`}>
            <span className="sr-only">{part}</span>
            {Array.from(part, (digit, place) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 右侧起算的十进制位是数字轮身份，位数变化时仍复用个位。
              <RollingDigit key={part.length - place} digit={digit} />
            ))}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 标签槽位不随数字值变化，保留节点避免文字重新挂载。
          <span key={`label-${index}`} data-stat-label="">
            {part}
          </span>
        ),
      )}
    </span>
  );
}
