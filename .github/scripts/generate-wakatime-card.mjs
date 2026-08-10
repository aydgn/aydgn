import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://wakatime.com/api/v1/users/current/stats/all_time";
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 10_000;
const CARD_WIDTH = 495;
const CARD_HEIGHT = 195;
const BAR_X = 25;
const BAR_WIDTH = 445;
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../profile/wakatime.svg",
);

const LANGUAGE_COLORS = new Map([
  ["c", "#555555"],
  ["c#", "#178600"],
  ["c++", "#f34b7d"],
  ["css", "#663399"],
  ["dart", "#00b4ab"],
  ["go", "#00add8"],
  ["html", "#e34c26"],
  ["java", "#b07219"],
  ["javascript", "#f1e05a"],
  ["json", "#292929"],
  ["jsx", "#61dafb"],
  ["kotlin", "#a97bff"],
  ["markdown", "#083fa1"],
  ["php", "#4f5d95"],
  ["python", "#3572a5"],
  ["ruby", "#701516"],
  ["rust", "#dea584"],
  ["scss", "#c6538c"],
  ["shell", "#89e051"],
  ["svelte", "#ff3e00"],
  ["swift", "#f05138"],
  ["tsx", "#3178c6"],
  ["typescript", "#3178c6"],
  ["vue", "#41b883"],
  ["vue.js", "#41b883"],
]);

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDuration(totalSeconds) {
  const roundedMinutes = Math.max(0, Math.round(totalSeconds / 60));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;

  if (hours === 0) {
    return `${minutes} min${minutes === 1 ? "" : "s"}`;
  }

  return `${hours.toLocaleString("en-US")} hrs ${minutes} mins`;
}

function formatPercent(percent) {
  return `${percent.toFixed(2).replace(/\.00$/, "")}%`;
}

function validateStats(payload) {
  const data = payload?.data;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  if (!Array.isArray(data.languages)) {
    return null;
  }

  const humanReadableTotal =
    typeof data.human_readable_total === "string"
      ? data.human_readable_total.trim()
      : "";
  const totalSeconds = toFiniteNumber(data.total_seconds);

  if (!humanReadableTotal && totalSeconds === null) {
    return null;
  }

  const languages = data.languages
    .filter((language) => language && typeof language === "object")
    .map((language) => {
      const name = typeof language.name === "string" ? language.name.trim() : "";
      const seconds = Math.max(0, toFiniteNumber(language.total_seconds) ?? 0);
      const suppliedPercent = toFiniteNumber(language.percent);
      const calculatedPercent =
        totalSeconds && totalSeconds > 0 ? (seconds / totalSeconds) * 100 : 0;

      return {
        name,
        percent: Math.min(100, Math.max(0, suppliedPercent ?? calculatedPercent)),
        seconds,
      };
    })
    .filter(
      (language) =>
        language.name &&
        language.name.toLocaleLowerCase("en-US") !== "other" &&
        (language.percent > 0 || language.seconds > 0),
    )
    .sort((left, right) =>
      right.percent === left.percent
        ? right.seconds - left.seconds
        : right.percent - left.percent,
    );

  if (languages.length === 0) {
    return null;
  }

  return {
    humanReadableTotal:
      humanReadableTotal || formatDuration(Math.max(0, totalSeconds)),
    isUpToDate:
      data.is_up_to_date !== false && payload.is_up_to_date !== false,
    languages,
  };
}

async function fetchStats(apiKey) {
  const authorization = `Basic ${Buffer.from(apiKey, "utf8").toString("base64")}`;
  let latestUsableStats = null;
  let lastFailure = "WakaTime did not return usable aggregate statistics.";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(API_URL, {
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          "User-Agent": "aydgn-profile-wakatime-card",
        },
      });

      if (response.status !== 200 && response.status !== 202) {
        lastFailure = `WakaTime API request failed with HTTP ${response.status}.`;

        if (response.status < 500 && response.status !== 429) {
          throw new Error(lastFailure);
        }
      } else {
        const responseText = await response.text();
        let payload = null;

        if (responseText) {
          try {
            payload = JSON.parse(responseText);
          } catch {
            lastFailure = "WakaTime API returned an invalid JSON response.";
          }
        }

        const stats = validateStats(payload);

        if (stats) {
          latestUsableStats = stats;
        } else {
          lastFailure = "WakaTime did not return usable aggregate statistics.";
        }

        const cacheIsReady = response.status === 200 && stats?.isUpToDate;

        if (stats && cacheIsReady) {
          return stats;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("WakaTime API")) {
        throw error;
      }

      lastFailure = "Unable to reach the WakaTime API.";
    }

    if (attempt < MAX_ATTEMPTS) {
      console.log(
        `WakaTime stats are still being prepared (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in 10 seconds.`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  if (latestUsableStats) {
    console.log("Using the latest usable cached WakaTime statistics.");
    return latestUsableStats;
  }

  throw new Error(lastFailure);
}

function languageColor(name) {
  return LANGUAGE_COLORS.get(name.toLocaleLowerCase("en-US")) ?? "#8b949e";
}

function renderDistributionBar(languages) {
  const percentTotal = languages.reduce(
    (total, language) => total + language.percent,
    0,
  );
  const secondsTotal = languages.reduce(
    (total, language) => total + language.seconds,
    0,
  );
  const usePercent = percentTotal > 0;
  const weightTotal = usePercent ? percentTotal : secondsTotal;
  let currentX = BAR_X;

  return languages
    .map((language, index) => {
      const weight = usePercent ? language.percent : language.seconds;
      const width =
        index === languages.length - 1
          ? BAR_X + BAR_WIDTH - currentX
          : (weight / weightTotal) * BAR_WIDTH;
      const segment = `    <rect x="${currentX.toFixed(2)}" y="72" width="${Math.max(
        0,
        width,
      ).toFixed(2)}" height="8" fill="${languageColor(language.name)}" />`;

      currentX += width;
      return segment;
    })
    .join("\n");
}

function renderLanguageItems(languages) {
  return languages
    .map((language, index) => {
      const column = Math.floor(index / 3);
      const row = index % 3;
      const x = column === 0 ? 25 : 255;
      const valueX = column === 0 ? 235 : 465;
      const y = 113 + row * 25;
      const name = escapeXml(language.name);
      const percent = escapeXml(formatPercent(language.percent));
      const color = languageColor(language.name);

      return `    <g data-testid="lang-item">
      <circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${color}" />
      <text data-testid="lang-name" x="${x + 15}" y="${y}" class="lang-name">${name}</text>
      <text x="${valueX}" y="${y}" text-anchor="end" class="lang-value">${percent}</text>
    </g>`;
    })
    .join("\n");
}

function renderCard(stats) {
  const languages = stats.languages.slice(0, 6);
  const total = escapeXml(stats.humanReadableTotal);
  const summary = escapeXml(
    languages
      .map((language) => `${language.name} ${formatPercent(language.percent)}`)
      .join(", "),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="titleId descId">
  <title id="titleId">WakaTime Stats</title>
  <desc id="descId">All-time aggregate coding time: ${total}. Top languages: ${summary}.</desc>
  <style>
    .card { fill: #fffefe; stroke: #e4e2e2; }
    .title { fill: #2f80ed; font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; }
    .subtitle { fill: #57606a; font: 400 12px 'Segoe UI', Ubuntu, Sans-Serif; }
    .lang-name { fill: #434d58; font: 600 12px 'Segoe UI', Ubuntu, Sans-Serif; }
    .lang-value { fill: #57606a; font: 400 11px 'Segoe UI', Ubuntu, Sans-Serif; }
    @media (prefers-color-scheme: dark) {
      .card { fill: #0d1117; stroke: #30363d; }
      .title { fill: #58a6ff; }
      .subtitle, .lang-value { fill: #8b949e; }
      .lang-name { fill: #c9d1d9; }
    }
  </style>
  <rect class="card" x="0.5" y="0.5" width="494" height="194" rx="4.5" />
  <text x="25" y="32" class="title">WakaTime Stats</text>
  <text x="25" y="52" class="subtitle">All time · ${total}</text>
  <g clip-path="url(#language-bar-clip)" data-testid="lang-progress">
${renderDistributionBar(languages)}
  </g>
  <clipPath id="language-bar-clip">
    <rect x="${BAR_X}" y="72" width="${BAR_WIDTH}" height="8" rx="4" />
  </clipPath>
${renderLanguageItems(languages)}
</svg>`;
}

async function main() {
  const apiKey = process.env.WAKATIME_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "WAKATIME_API_KEY is required to generate the authenticated WakaTime card.",
    );
  }

  const stats = await fetchStats(apiKey);
  const svg = renderCard(stats);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${svg}\n`, "utf8");
  console.log("Generated profile/wakatime.svg from aggregate WakaTime statistics.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unexpected error.";
  console.error(`WakaTime card generation failed: ${message}`);
  process.exitCode = 1;
});
