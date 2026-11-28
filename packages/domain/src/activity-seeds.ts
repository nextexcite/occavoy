import { z } from "zod";
import {
  type ActivityFieldEvidence,
  type ActivityOccurrence,
  type ActivityProvenance,
  activityOccurrenceSchema,
} from "./activity";

const TCD_OBSERVED_AT = "2026-11-28T16:30:00Z";
const LN_OBSERVED_AT = "2026-11-28T16:30:00Z";

const sourceRightsNote =
  "Concise factual metadata manually read once from a public first-party listing; no copied long description, image, inventory claim or reuse licence.";

function evidence(extras: ActivityFieldEvidence[] = []): ActivityFieldEvidence[] {
  return [
    { field: "title", locator: "detail page h1" },
    { field: "timing", locator: "開催日時 field" },
    { field: "place", locator: "会場 field" },
    { field: "status", locator: "detail page status badge" },
    ...extras,
  ];
}

function tcdProvenance(nativeId: string, extras: ActivityFieldEvidence[] = []): ActivityProvenance {
  return {
    evidenceKind: "source_observation",
    publisherId: "tokyo-culture-debut",
    sourceId: "tokyo-culture-debut:event-detail",
    nativeId,
    sourceUrl: `https://tokyo-culture-debut.rekibun.or.jp/events/${nativeId}/`,
    observedAt: TCD_OBSERVED_AT,
    retrievalMethod: "manual_bounded_public_read",
    fieldEvidence: evidence(extras),
    rightsNote: sourceRightsNote,
  };
}

function lnProvenance(nativeId: string, sourceUrl: string): ActivityProvenance {
  return {
    evidenceKind: "source_observation",
    publisherId: "live-nation-hip-japan",
    sourceId: "live-nation-hip:event-detail",
    nativeId,
    sourceUrl,
    observedAt: LN_OBSERVED_AT,
    retrievalMethod: "manual_bounded_public_read",
    fieldEvidence: [
      { field: "title", locator: "detail page h1" },
      { field: "timing", locator: "SCHEDULE section" },
      { field: "place", locator: "SCHEDULE venue" },
      { field: "status", locator: "upcoming-events detail listing and SCHEDULE section" },
      { field: "participation", locator: "TICKETS and Please Note sections" },
    ],
    rightsNote: sourceRightsNote,
  };
}

const notBookable = {
  state: "not_assessed",
  inventory: "not_observed",
  note: "Discovery seed only. Occavoy has not assessed inventory, supplier access or bookability.",
} as const;

function local(date: string, time: string, originalText: string) {
  return { precision: "local_datetime" as const, date, time, originalText };
}
function day(date: string, originalText: string) {
  return { precision: "date" as const, date, originalText };
}
function deadline(date: string, time: string, originalText: string) {
  return local(date, time, originalText);
}
const tokyo = { countryCode: "JP", city: "Tokyo", mapping: "occavoy_curated" } as const;
const jp = (text: string) => [{ text, language: "ja", kind: "original" as const }];
const en = (text: string) => [{ text, language: "en", kind: "original" as const }];
const venue = (name: string) => ({ name });

const rawJapanSeeds = [
  {
    id: "jp-tcd-1216-fantasista-marine-creatures",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("国際美術展 TOKYO ATLAS関連企画「ファンタジスタ：海の生物の表現」"),
    destination: tokyo,
    venue: venue("テレコムセンタービル５階アトリウム"),
    schedule: {
      start: day("2026-10-10", "2026年10月10日（土）～12月20日（日）"),
      end: day("2026-12-20", "2026年10月10日（土）～12月20日（日）"),
      walkInOpening: { opensAt: "10:00", closesAt: "17:00", originalText: "開場時間：10時－17時" },
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催中"],
    participation: {
      registration: "not_required",
      applicationStatus: "not_applicable",
      eligibility: "年齢制限なし",
      conditions: ["月曜休（祝日の場合、翌火曜休／10月12日、11月23日開場）", "事前申込なし"],
      costText: "無料",
    },
    prices: [],
    bookability: notBookable,
    provenance: tcdProvenance("1216", [
      { field: "participation", locator: "対象年齢・事前申込 fields" },
      { field: "opening", locator: "開催日時 field, opening-hours note" },
    ]),
  },
  {
    id: "jp-tcd-680-national-university-print-exhibition",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("第51回全国大学版画展"),
    destination: tokyo,
    venue: venue("たましん美術館"),
    schedule: {
      start: day("2026-10-21", "2026年10月21日（水）～12月20日（日）"),
      end: day("2026-12-20", "2026年10月21日（水）～12月20日（日）"),
      walkInOpening: { opensAt: "10:00", closesAt: "18:00", originalText: "10:00～18:00" },
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催中"],
    participation: {
      registration: "not_required",
      applicationStatus: "not_applicable",
      eligibility: "どなたでも",
      conditions: ["月曜休館（祝日の場合は翌平日）。11/23は開館、11/24は休館", "事前申込なし"],
      costText: "一般500円、高・大生300円（中学生以下等無料）",
    },
    prices: [
      {
        label: "general",
        amountMinor: 500,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "一般500円",
      },
      {
        label: "high-school or university student",
        amountMinor: 300,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "高・大生300円",
      },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("680", [
      { field: "participation", locator: "料金・対象年齢・注意事項 fields" },
      { field: "price", locator: "料金 field" },
      { field: "opening", locator: "開催日時 field" },
    ]),
  },
  {
    id: "jp-tcd-830-music-workshop-festa-winter",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("ミュージック・ワークショップ・フェスタ〈冬〉"),
    destination: tokyo,
    venue: venue("大田区民プラザ、大田区民ホール・アプリコ"),
    schedule: {
      start: day("2026-11-25", "2026年11月25日（水）～11月29日（日）"),
      end: day("2026-11-29", "2026年11月25日（水）～11月29日（日）"),
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催中", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "6か月～18歳",
      conditions: ["公演によって対象年齢が異なる", "詳細は公式サイト参照"],
      costText: "1公演につき1人550円",
    },
    prices: [
      {
        label: "per performance",
        amountMinor: 550,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "1公演につき1人550円",
      },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("830", [
      { field: "participation", locator: "対象年齢・事前申込・注意事項 fields" },
      { field: "price", locator: "料金 field" },
    ]),
  },
  {
    id: "jp-tcd-2642-bamboo-toy-workshop",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: jp("竹のひみつ発見！ ― つくってあそぶ むかしのおもちゃ ―"),
    destination: tokyo,
    venue: venue("江戸東京たてもの園"),
    schedule: {
      start: local("2026-11-29", "12:30", "2026年11月29日(日) 12:30～15:30"),
      end: local("2026-11-29", "15:30", "2026年11月29日(日) 12:30～15:30"),
      registrationDeadline: deadline("2026-11-28", "17:00", "申込締切：11月28日（土）17:00"),
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催中", "募集終了"],
    participation: {
      registration: "required",
      applicationStatus: "closed",
      eligibility: "小学生",
      conditions: ["定員10名、先着順", "中学生以上の付添者は別途観覧料", "早退不可"],
      costText: "無料（付添の中学生以上は別途観覧料）",
    },
    prices: [],
    bookability: notBookable,
    provenance: tcdProvenance("2642", [
      { field: "participation", locator: "対象年齢・事前申込 fields" },
      { field: "registration_deadline", locator: "事前申込 field, 申込締切" },
    ]),
  },
  {
    id: "jp-tcd-2645-building-explorers",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: jp("たてもの探検隊になろう！～建物のナゾを解いて、昭和の暮らしを発見しよう～"),
    destination: tokyo,
    venue: venue("江戸東京たてもの園"),
    schedule: {
      start: local("2026-11-29", "13:30", "2026年11月29日（日）13:30〜15:30"),
      end: local("2026-11-29", "15:30", "2026年11月29日（日）13:30〜15:30"),
      registrationDeadline: deadline("2026-11-28", "17:00", "申込締切：11月28日（土）17:00"),
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催中", "募集終了"],
    participation: {
      registration: "required",
      applicationStatus: "closed",
      eligibility: "小学4年生から6年生",
      conditions: ["定員16名、先着順", "大人の付添者は別途観覧料", "電子メールによる事前申込"],
      costText: "無料（大人の付添者は別途観覧料）",
    },
    prices: [],
    bookability: notBookable,
    provenance: tcdProvenance("2645", [
      { field: "participation", locator: "料金・対象年齢・事前申込 fields" },
      { field: "registration_deadline", locator: "事前申込 field, 申込締切" },
    ]),
  },
  {
    id: "jp-tcd-2682-tokyo-atlas-ito-no-toi",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: jp("国際美術展 TOKYO ATLAS 盛圭太ワークショップ「いとのとい」"),
    destination: tokyo,
    venue: venue("アイルしながわ、EZOHUB TOKYO"),
    schedule: {
      start: local("2026-12-06", "10:00", "2026年12月6日（日）10:00 – 12:00（受付 9:45）"),
      end: local("2026-12-06", "12:00", "2026年12月6日（日）10:00 – 12:00（受付 9:45）"),
      registrationDeadline: deadline("2026-12-05", "17:00", "申込締切：12月5日（土）17:00"),
      checkInTime: local("2026-12-06", "09:45", "受付 9:45"),
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "中学生、高校生",
      conditions: ["展示会場に照明を落とした暗いエリアがある", "ArtStickerの来場予約から申込"],
      costText: "無料",
    },
    prices: [],
    bookability: notBookable,
    provenance: tcdProvenance("2682", [
      { field: "participation", locator: "対象年齢・事前申込・注意事項 fields" },
      { field: "registration_deadline", locator: "事前申込 field, 申込締切" },
      { field: "check_in_time", locator: "開催日時 field, 受付 9:45" },
    ]),
  },
  {
    id: "jp-tcd-2694-shinkiba-creative-hub-2026",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("SHINKIBA CREATIVE HUB 2026"),
    destination: tokyo,
    venue: venue("新木場、辰巳エリア（各参加企業の拠点）"),
    schedule: {
      start: day("2026-12-10", "2026年12月10日（木）～12日（土）"),
      end: day("2026-12-12", "2026年12月10日（木）～12日（土）"),
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "partially_required",
      applicationStatus: "accepting",
      conditions: ["一部の会場・ワークショップは事前予約が必要", "一部ワークショップ等は有料"],
      costText: "無料（一部ワークショップ等は有料）",
    },
    prices: [],
    bookability: notBookable,
    provenance: tcdProvenance("2694", [
      { field: "participation", locator: "料金・事前申込 fields" },
    ]),
  },
  {
    id: "jp-tcd-650-nutcracker-full-length",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("「くるみ割り人形」（全幕）"),
    destination: tokyo,
    venue: venue("文京シビックホール 大ホール"),
    schedule: {
      start: day("2026-12-12", "2026年12月12日（土）〜13日（日）"),
      end: day("2026-12-13", "2026年12月12日（土）〜13日（日）"),
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "4歳以上",
      conditions: ["チケット購入が必要", "一般発売は9/9から"],
      costText: "S席14,000円ほか複数席種",
    },
    prices: [
      {
        label: "S seat",
        amountMinor: 14000,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "S席：14,000円",
      },
      {
        label: "economy seat",
        amountMinor: 3000,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "エコノミー席：3,000円",
      },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("650", [
      { field: "participation", locator: "対象年齢・事前申込 fields" },
      { field: "price", locator: "料金 field" },
    ]),
  },
  {
    id: "jp-tcd-1908-broadway-christmas-wonderland-2026",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("ブロードウェイ クリスマス・ワンダーランド2026"),
    destination: tokyo,
    venue: venue("東急シアターオーブ（渋谷ヒカリエ11階）"),
    schedule: {
      start: day("2026-12-12", "2026年12月12日（土）～12月25日（金）全16公演"),
      end: day("2026-12-25", "2026年12月12日（土）～12月25日（金）全16公演"),
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "3歳～",
      conditions: ["1人1枚のチケットが必要", "膝上での観劇不可", "全席指定"],
      costText: "S席11,800円 A席7,800円 B席4,800円(税込)",
    },
    prices: [
      {
        label: "S seat",
        amountMinor: 11800,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "S席11,800円",
      },
      {
        label: "B seat",
        amountMinor: 4800,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "B席4,800円",
      },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("1908", [
      { field: "participation", locator: "対象年齢・事前申込 fields" },
      { field: "price", locator: "料金 field" },
    ]),
  },
  {
    id: "jp-tcd-1903-sesion-christmas-family-concert",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("セシオン杉並 Meet The Artists vol.10 クリスマスファミリーコンサート2026"),
    destination: tokyo,
    venue: venue("セシオン杉並ホール"),
    schedule: {
      start: local("2026-12-13", "11:00", "2026年12月13日（日）11:00開演・14:00開演"),
      sessions: [
        {
          id: "2026-12-13-1100",
          label: "11:00 performance",
          start: local("2026-12-13", "11:00", "2026年12月13日（日）11:00開演"),
        },
        {
          id: "2026-12-13-1400",
          label: "14:00 performance",
          start: local("2026-12-13", "14:00", "2026年12月13日（日）14:00開演"),
        },
      ],
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "4歳以上入場可",
      conditions: [
        "1人1枚のチケットが必要",
        "一回の受付につき4枚まで",
        "公演前日まで購入可能と記載",
      ],
      costText: "2,000円（税込・全席指定）",
    },
    prices: [
      {
        label: "reserved seat",
        amountMinor: 2000,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "2,000円（税込・全席指定）",
      },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("1903", [
      { field: "participation", locator: "料金・対象年齢・事前申込 fields" },
      { field: "price", locator: "料金 field" },
    ]),
  },
  {
    id: "jp-tcd-2566-god-hands-edo",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("探究プログラム「ゴッドハンズ江戸」"),
    destination: tokyo,
    venue: venue("東京都江戸東京博物館"),
    schedule: {
      start: local(
        "2026-12-16",
        "13:00",
        "2026年12月16日（水）、17日（木）13:00～／2027年1月20日（水）、27日（水）13:00～",
      ),
      sessions: [
        {
          id: "2026-12-16",
          start: local("2026-12-16", "13:00", "2026年12月16日（水）13:00～"),
          registrationDeadline: day(
            "2026-12-04",
            "12月のプログラム申込期間：11月2日（月）～12月4日（金）",
          ),
        },
        {
          id: "2026-12-17",
          start: local("2026-12-17", "13:00", "2026年12月17日（木）13:00～"),
          registrationDeadline: day(
            "2026-12-04",
            "12月のプログラム申込期間：11月2日（月）～12月4日（金）",
          ),
        },
        {
          id: "2027-01-20",
          start: local("2027-01-20", "13:00", "2027年1月20日（水）13:00～"),
          registrationDeadline: day(
            "2026-12-21",
            "1月のプログラム申込期間：11月2日（月）～12月21日（月）",
          ),
        },
        {
          id: "2027-01-27",
          start: local("2027-01-27", "13:00", "2027年1月27日（水）13:00～"),
          registrationDeadline: day(
            "2026-12-21",
            "1月のプログラム申込期間：11月2日（月）～12月21日（月）",
          ),
        },
      ],
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility:
        "学校に行きづらさを感じている小学4年生から中学3年生（東京都内在住または在学・在勤）",
      conditions: ["12月と1月の両方に申込可能", "配慮が必要な場合は申込フォームで確認"],
      costText: "無料",
    },
    prices: [],
    bookability: notBookable,
    provenance: tcdProvenance("2566", [
      { field: "participation", locator: "対象年齢・事前申込 fields" },
      { field: "registration_deadline", locator: "事前申込 field, 申込期間" },
    ]),
  },
  {
    id: "jp-tcd-1869-toy-orchestra-winter-wonderland",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("おもちゃの楽団のウィンターワンダーランド"),
    destination: tokyo,
    venue: venue("としま区民センター"),
    schedule: {
      start: day("2026-12-19", "2026年12月19日(土)・20日(日)"),
      end: day("2026-12-20", "2026年12月19日(土)・20日(日)"),
      walkInOpening: { opensAt: "10:00", originalText: "ワークショップ：10時受付開始" },
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "コンサートは0歳から、ワークショップは小学生とその保護者",
      conditions: [
        "ワークショップは小学生と保護者1組",
        "2歳以下はコンサート無料",
        "複数の申込経路が記載",
      ],
      costText: "ワークショップ＆コンサート1組3,000円ほか",
    },
    prices: [
      {
        label: "workshop and concert pair",
        amountMinor: 3000,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "ワークショップ＆コンサート 1組3,000円",
      },
      {
        label: "concert child",
        amountMinor: 500,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "こども500円",
      },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("1869", [
      { field: "participation", locator: "料金・対象年齢・事前申込 fields" },
      { field: "price", locator: "料金 field" },
      { field: "opening", locator: "開催日時 field, workshop reception" },
    ]),
  },
  {
    id: "jp-tcd-2739-postal-museum-clay-class",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("郵政博物館でクリスマス&新春ねんど教室"),
    destination: tokyo,
    venue: venue("郵政博物館"),
    schedule: {
      start: local(
        "2026-12-20",
        "11:30",
        "2026年12月20日(日)／2027年1月16日(土) Ａ 11時30分～13時、Ｂ 14時30分～16時",
      ),
      end: local(
        "2027-01-16",
        "16:00",
        "2026年12月20日(日)／2027年1月16日(土) Ａ 11時30分～13時、Ｂ 14時30分～16時",
      ),
      sessions: [
        {
          id: "2026-12-20-a",
          label: "A",
          start: local("2026-12-20", "11:30", "2026年12月20日(日) Ａ 11時30分～13時"),
          end: local("2026-12-20", "13:00", "2026年12月20日(日) Ａ 11時30分～13時"),
          checkInTime: local("2026-12-20", "11:20", "集合時間11時20分"),
        },
        {
          id: "2026-12-20-b",
          label: "B",
          start: local("2026-12-20", "14:30", "2026年12月20日(日) Ｂ 14時30分～16時"),
          end: local("2026-12-20", "16:00", "2026年12月20日(日) Ｂ 14時30分～16時"),
          checkInTime: local("2026-12-20", "14:20", "集合時間14時20分"),
        },
        {
          id: "2027-01-16-a",
          label: "A",
          start: local("2027-01-16", "11:30", "2027年1月16日(土) Ａ 11時30分～13時"),
          end: local("2027-01-16", "13:00", "2027年1月16日(土) Ａ 11時30分～13時"),
          checkInTime: local("2027-01-16", "11:20", "集合時間11時20分"),
        },
        {
          id: "2027-01-16-b",
          label: "B",
          start: local("2027-01-16", "14:30", "2027年1月16日(土) Ｂ 14時30分～16時"),
          end: local("2027-01-16", "16:00", "2027年1月16日(土) Ｂ 14時30分～16時"),
          checkInTime: local("2027-01-16", "14:20", "集合時間14時20分"),
        },
      ],
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "3歳以上の子どもと保護者、または大人のグループ",
      conditions: [
        "1回2名のペア参加",
        "付添いや見学のみは不可",
        "開始10分前集合厳守",
        "別途入館料",
      ],
      costText: "ペア参加（1回2名）5,000円",
    },
    prices: [
      {
        label: "pair participation",
        amountMinor: 5000,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "ペア参加（１回２名様）５０００円",
      },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("2739", [
      { field: "participation", locator: "料金・対象年齢・事前申込・注意事項 fields" },
      { field: "check_in_time", locator: "開催日時 field, 集合時間" },
      { field: "price", locator: "料金 field" },
    ]),
  },
  {
    id: "jp-tcd-835-sea-friends-workshop-concert",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: jp("ワークショップ・コンサート「海の仲間の音楽会～ふしぎな宝箱のひみつ～」"),
    destination: tokyo,
    venue: venue("台東区生涯学習センター ミレニアムホール"),
    schedule: { start: day("2026-12-26", "2026年12月26日（土）") },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "6か月～小学生",
      conditions: ["保護者（中学生以上）・家族同伴", "詳細は公式サイト参照"],
      costText: "1人550円",
    },
    prices: [
      {
        label: "per person",
        amountMinor: 550,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "1人550円",
      },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("835", [
      { field: "participation", locator: "料金・対象年齢・事前申込・注意事項 fields" },
      { field: "price", locator: "料金 field" },
    ]),
  },
  {
    id: "jp-tcd-2773-miniature-food-class",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: jp("ねんどで食育！ミニチュアフード教室"),
    destination: tokyo,
    venue: venue("ホテルニューオータニ ガーデンタワー 翠鳳"),
    schedule: {
      start: local("2027-01-02", "10:00", "2027年1月2日(土) ①10時〜11時 ②16時〜17時"),
      end: local("2027-01-02", "17:00", "2027年1月2日(土) ①10時〜11時 ②16時〜17時"),
      sessions: [
        {
          id: "2027-01-02-1000",
          label: "①",
          start: local("2027-01-02", "10:00", "2027年1月2日(土) ①10時〜11時"),
          end: local("2027-01-02", "11:00", "2027年1月2日(土) ①10時〜11時"),
        },
        {
          id: "2027-01-02-1600",
          label: "②",
          start: local("2027-01-02", "16:00", "2027年1月2日(土) ②16時〜17時"),
          end: local("2027-01-02", "17:00", "2027年1月2日(土) ②16時〜17時"),
        },
      ],
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "3歳以上の子どもと保護者",
      conditions: ["お正月プラン利用者限定", "定員に限りあり", "事前予約制"],
      costText: "お正月プラン利用者は通行手形提示で入場無料",
    },
    prices: [],
    bookability: notBookable,
    provenance: tcdProvenance("2773", [
      { field: "participation", locator: "料金・対象年齢・事前申込 fields" },
    ]),
  },
  {
    id: "jp-tcd-2596-cultural-childcare-tokyo-met-theatre",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: jp("文化体験型託児サービス（東京芸術劇場 コンサートホール）"),
    destination: tokyo,
    venue: venue("東京芸術劇場 コンサートホール"),
    schedule: {
      start: local("2027-01-11", "14:00", "2027年1月11日（月・祝）14:00～"),
      registrationDeadline: deadline("2027-01-10", "17:00", "申込期間：前日17時まで"),
    },
    eventStatus: "scheduled",
    sourceStatusText: ["開催前", "募集中"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "生後1か月～12歳",
      conditions: ["保護者1名分の対象公演チケットが必要", "予約フォームより先着順"],
      costText: "500円（要対象公演チケット 保護者1名分）",
    },
    prices: [
      { label: "childcare", amountMinor: 500, currency: "JPY", minorUnit: 0, sourceText: "500円" },
    ],
    bookability: notBookable,
    provenance: tcdProvenance("2596", [
      { field: "participation", locator: "料金・対象年齢・事前申込・注意事項 fields" },
      { field: "registration_deadline", locator: "事前申込 field, 前日17時まで" },
    ]),
  },
  {
    id: "jp-tsukuba-wakudoki-safety-festa-2026",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "edition",
    titles: jp("ワクドキ安全・安心フェスタ2026"),
    destination: { countryCode: "JP", city: "Tsukuba", mapping: "occavoy_curated" },
    venue: venue("つくばカピオ"),
    schedule: {
      start: local(
        "2026-12-05",
        "10:00",
        "12/5 10:00-12:30, 13:30-16:00; 12/6 10:00-12:30, 13:30-16:00",
      ),
      end: local(
        "2026-12-06",
        "16:00",
        "12/5 10:00-12:30, 13:30-16:00; 12/6 10:00-12:30, 13:30-16:00",
      ),
      sessions: [
        {
          id: "2026-12-05-morning",
          start: local("2026-12-05", "10:00", "12/5 10:00-12:30"),
          end: local("2026-12-05", "12:30", "12/5 10:00-12:30"),
        },
        {
          id: "2026-12-05-afternoon",
          start: local("2026-12-05", "13:30", "12/5 13:30-16:00"),
          end: local("2026-12-05", "16:00", "12/5 13:30-16:00"),
        },
        {
          id: "2026-12-06-morning",
          start: local("2026-12-06", "10:00", "12/6 10:00-12:30"),
          end: local("2026-12-06", "12:30", "12/6 10:00-12:30"),
        },
        {
          id: "2026-12-06-afternoon",
          start: local("2026-12-06", "13:30", "12/6 13:30-16:00"),
          end: local("2026-12-06", "16:00", "12/6 13:30-16:00"),
        },
      ],
    },
    eventStatus: "scheduled",
    sourceStatusText: ["つくば市イベント情報（2026年11～12月）掲載"],
    participation: {
      registration: "unknown",
      applicationStatus: "unknown",
      conditions: [
        "Scoped projection records organizer/contact but no eligibility or registration requirement",
        "Four explicit sessions are listed; the source does not declare a timezone",
      ],
      accessRouteUrl: "https://www.city.tsukuba.lg.jp/kurashi/oshirase/29741.html",
    },
    prices: [],
    bookability: notBookable,
    provenance: {
      evidenceKind: "source_observation",
      publisherId: "city-of-tsukuba",
      sourceId: "tsukuba-event-information-workbook",
      nativeId: "row-27-wakudoki-safety-festa-2026",
      sourceUrl: "https://www.city.tsukuba.lg.jp/material/files/group/177/1112eventexcel.xlsx",
      observedAt: "2026-11-28T15:55:18.953Z",
      retrievalMethod: "eventsquare_projection_receipt",
      fieldEvidence: [
        { field: "title", locator: "イベント情報!A27" },
        {
          field: "timing",
          locator: "イベント情報!C27",
          excerpt: "12/5 10:00-12:30, 13:30-16:00; 12/6 10:00-12:30, 13:30-16:00",
        },
        { field: "place", locator: "イベント情報!D27" },
        {
          field: "status",
          locator:
            "row 27 inclusion in つくば市イベント情報（2026年11～12月）, workbook dated 2026-11-10",
        },
        { field: "participation", locator: "イベント情報!E27:G27" },
      ],
      rightsNote:
        "City of Tsukuba; adapted factual projection; CC BY 4.0. No timezone is declared in the source workbook.",
      attribution: "City of Tsukuba",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      adaptationNote:
        "Adapted factual projection: source cell text was structured into four explicit sessions without adding timezone, price or registration facts.",
    },
  },
  {
    id: "jp-ln-khalid-tokyo-2026-12-03",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: en("Khalid - It's Always Summer Somewhere Tour"),
    destination: tokyo,
    venue: venue("Tokyo Garden Theater"),
    schedule: {
      start: local("2026-12-03", "19:00", "December 3rd (Thu), 2026; DOORS 6:00 PM / SHOW 7:00 PM"),
      walkInOpening: { opensAt: "18:00", originalText: "DOORS 6:00 PM" },
    },
    eventStatus: "scheduled",
    sourceStatusText: ["upcoming show"],
    participation: {
      registration: "required",
      applicationStatus: "closed",
      eligibility:
        "Children aged 6 and above require a ticket; children under 6 are not allowed entry",
      conditions: [
        "Purchaser name must match attendee photo ID",
        "No re-entry",
        "General on sale is marked Finished",
      ],
      accessRouteUrl: "https://www.livenationhip.co.jp/en/all-events/khalid-tickets-ae928417",
      costText: "GOLD Seat ¥42,800; SS Seat ¥18,800; S Seat ¥12,800 (w/ tax)",
    },
    prices: [
      {
        label: "GOLD seat",
        amountMinor: 42800,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "GOLD Seat ¥42,800 (w/ tax)",
      },
      {
        label: "S seat",
        amountMinor: 12800,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "S Seat ¥12,800 (w/ tax)",
      },
    ],
    bookability: notBookable,
    provenance: lnProvenance(
      "khalid-ae928417",
      "https://www.livenationhip.co.jp/en/all-events/khalid-tickets-ae928417",
    ),
  },
  {
    id: "jp-ln-fkj-tokyo-2026-12-10",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: jp("FKJ: Tyber Tour"),
    destination: tokyo,
    venue: venue("東京国際フォーラム ホールA"),
    schedule: {
      start: local("2026-12-10", "19:00", "2026年12月10日(木) OPEN 18:00 / START 19:00"),
      walkInOpening: { opensAt: "18:00", originalText: "OPEN 18:00" },
    },
    eventStatus: "scheduled",
    sourceStatusText: ["SCHEDULE掲載", "SOLD OUT"],
    participation: {
      registration: "required",
      applicationStatus: "closed",
      eligibility: "6歳未満入場不可・6歳以上有料",
      conditions: ["全チケット完売と記載", "本人確認を行う場合あり", "再入場不可"],
      accessRouteUrl: "https://www.livenationhip.co.jp/all-events/fkj-tickets-ae1212035",
      costText: "SS席15,800円、S席11,800円（税込、いずれもSOLD OUT）",
    },
    prices: [
      {
        label: "SS seat",
        amountMinor: 15800,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "SS席 ￥15,800 (税込)",
      },
      {
        label: "S seat",
        amountMinor: 11800,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "S席 ￥11,800 (税込)",
      },
    ],
    bookability: notBookable,
    provenance: lnProvenance(
      "fkj-ae1212035",
      "https://www.livenationhip.co.jp/all-events/fkj-tickets-ae1212035",
    ),
  },
  {
    id: "jp-ln-against-the-current-tokyo-2027-01-13",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: jp("Against The Current: Till Death & Back Tour"),
    destination: tokyo,
    venue: venue("Spotify O-EAST"),
    schedule: {
      start: local("2027-01-13", "19:00", "2027年1月13日(水) OPEN 18:00 / START 19:00"),
      walkInOpening: { opensAt: "18:00", originalText: "OPEN 18:00" },
    },
    eventStatus: "scheduled",
    sourceStatusText: ["SCHEDULE掲載"],
    participation: {
      registration: "required",
      applicationStatus: "accepting",
      eligibility: "6歳未満入場不可・6歳以上有料",
      conditions: ["購入者本人確認あり", "VIPスタンディングと2F指定席はSOLD OUT", "再入場不可"],
      accessRouteUrl:
        "https://www.livenationhip.co.jp/all-events/against-the-current-tickets-ae671869",
      costText: "スタンディング7,800円、2F指定席10,800円（税込）",
    },
    prices: [
      {
        label: "standing",
        amountMinor: 7800,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "スタンディング ￥7,800 (税込)",
      },
      {
        label: "2F reserved",
        amountMinor: 10800,
        currency: "JPY",
        minorUnit: 0,
        sourceText: "2F指定席 ￥10,800 (税込)",
      },
    ],
    bookability: notBookable,
    provenance: lnProvenance(
      "against-the-current-ae671869",
      "https://www.livenationhip.co.jp/all-events/against-the-current-tickets-ae671869",
    ),
  },
];

export const japanActivitySeeds: ActivityOccurrence[] = z
  .array(activityOccurrenceSchema)
  .parse(rawJapanSeeds);

const fixtureEvidence: ActivityFieldEvidence[] = [
  { field: "title", locator: "checked-in fixture object" },
  { field: "timing", locator: "checked-in fixture object" },
  { field: "place", locator: "checked-in fixture object" },
  { field: "status", locator: "checked-in fixture object" },
];

function fixtureProvenance(nativeId: string): ActivityProvenance {
  return {
    evidenceKind: "synthetic_fixture",
    publisherId: "occavoy-test-fixtures",
    sourceId: "occavoy:activity-portability-fixtures",
    nativeId,
    sourceUrl: "https://example.invalid/occavoy/activity-portability-fixtures",
    observedAt: "2026-11-28T16:30:00Z",
    retrievalMethod: "checked_in_synthetic_fixture",
    fieldEvidence: fixtureEvidence,
    rightsNote:
      "Synthetic boundary fixture; not a real place, event, offer, supplier or source observation.",
  };
}

const fixtureBookability = {
  state: "synthetic_only",
  inventory: "not_observed",
  note: "Synthetic portability fixture; never present as customer inventory.",
} as const;

const rawPortabilityFixtures = [
  {
    id: "fixture-gb-london-dst-transition",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: en("Synthetic London DST boundary concert"),
    destination: {
      countryCode: "GB",
      city: "London",
      timeZone: "Europe/London",
      mapping: "occavoy_curated",
    },
    venue: venue("Synthetic Test Hall"),
    schedule: {
      start: {
        precision: "instant",
        instant: "2027-03-28T00:30:00+00:00",
        timeZone: "Europe/London",
        originalText: "synthetic UTC-offset instant before the spring forward transition",
      },
      end: {
        precision: "instant",
        instant: "2027-03-28T03:30:00+01:00",
        timeZone: "Europe/London",
        originalText: "synthetic UTC-offset instant after the spring forward transition",
      },
    },
    eventStatus: "scheduled",
    sourceStatusText: ["synthetic fixture"],
    participation: {
      registration: "unknown",
      applicationStatus: "unknown",
      conditions: ["Synthetic fixture only", "No real event or ticket availability"],
    },
    prices: [
      {
        label: "synthetic adult admission",
        amountMinor: 1250,
        currency: "GBP",
        minorUnit: 2,
        sourceText: "synthetic GBP 12.50 boundary amount",
      },
    ],
    bookability: fixtureBookability,
    provenance: fixtureProvenance("gb-london-dst-transition"),
  },
  {
    id: "fixture-np-kathmandu-fractional-offset",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: en("Synthetic Kathmandu fractional-offset walk"),
    destination: {
      countryCode: "NP",
      city: "Kathmandu",
      timeZone: "Asia/Kathmandu",
      mapping: "occavoy_curated",
    },
    venue: venue("Synthetic Kathmandu Meeting Point"),
    schedule: {
      start: {
        precision: "local_datetime",
        date: "2027-04-15",
        time: "09:15",
        timeZone: "Asia/Kathmandu",
        originalText: "synthetic 09:15 Asia/Kathmandu local start",
      },
    },
    eventStatus: "scheduled",
    sourceStatusText: ["synthetic fixture"],
    participation: {
      registration: "unknown",
      applicationStatus: "unknown",
      conditions: [
        "Synthetic fixture only",
        "Timezone is fractional UTC+05:45 and is not converted to a default zone",
      ],
    },
    prices: [
      {
        label: "synthetic admission",
        amountMinor: 12345,
        currency: "BHD",
        minorUnit: 3,
        sourceText: "synthetic BHD 12.345 three-decimal amount",
      },
    ],
    bookability: fixtureBookability,
    provenance: fixtureProvenance("np-kathmandu-fractional-offset"),
  },
  {
    id: "fixture-hk-mixed-currency-date-only",
    schemaVersion: "occavoy.activity/0.1.0",
    level: "occurrence",
    titles: en("Synthetic Hong Kong mixed-currency date-only workshop"),
    destination: {
      countryCode: "HK",
      city: "Hong Kong",
      timeZone: "Asia/Hong_Kong",
      mapping: "occavoy_curated",
    },
    venue: venue("Synthetic Harbour Studio"),
    schedule: {
      start: {
        precision: "date",
        date: "2027-05-01",
        timeZone: "Asia/Hong_Kong",
        originalText: "synthetic date-only listing",
      },
      end: {
        precision: "date",
        date: "2027-05-02",
        timeZone: "Asia/Hong_Kong",
        originalText: "synthetic date-only listing",
      },
    },
    eventStatus: "unknown",
    sourceStatusText: ["synthetic fixture"],
    participation: {
      registration: "unknown",
      applicationStatus: "unknown",
      conditions: [
        "Synthetic fixture only",
        "Mixed-currency components remain separate and must not be raw-added",
      ],
    },
    prices: [
      {
        label: "synthetic workshop component",
        amountMinor: 8800,
        currency: "HKD",
        minorUnit: 2,
        sourceText: "synthetic HKD 88.00 component",
      },
      {
        label: "synthetic museum component",
        amountMinor: 2500,
        currency: "EUR",
        minorUnit: 2,
        sourceText: "synthetic EUR 25.00 component",
      },
    ],
    bookability: fixtureBookability,
    provenance: fixtureProvenance("hk-mixed-currency-date-only"),
  },
];

export const activityPortabilityFixtures: ActivityOccurrence[] = z
  .array(activityOccurrenceSchema)
  .parse(rawPortabilityFixtures);
