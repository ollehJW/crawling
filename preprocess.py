from __future__ import annotations

import sys
from pathlib import Path

try:
    import pandas as pd
except ModuleNotFoundError as exc:
    raise SystemExit(
        "pandas가 필요합니다. 먼저 실행하세요: python3 -m pip install pandas openpyxl"
    ) from exc

INPUT_FILES = [
    "품번별 발주 진행현황_20160801_20170731.xlsx",
    "품번별 발주 진행현황_20170801_20180731.xlsx",
    "품번별 발주 진행현황_20180801_20190731.xlsx",
    "품번별 발주 진행현황_20190801_20200731.xlsx",
    "품번별 발주 진행현황_20200801_20210731.xlsx",
    "품번별 발주 진행현황_20210801_20220731.xlsx",
    "품번별 발주 진행현황_20220801_20230731.xlsx",
    "품번별 발주 진행현황_20230801_20240731.xlsx",
    "품번별 발주 진행현황_20240801_20250731.xlsx",
    "품번별 발주 진행현황_20250801_20260731.xlsx",
]
OUTPUT_FILE = "merged_vaatz_20160801_20260731.csv"

FACTORY_CODE_COLUMN = "공장코드"
ORDER_AMOUNT_COLUMN = "발주금액"
TARGET_FACTORY_CODE = "1020"
MIN_ORDER_AMOUNT = 100_000_000


def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(column).strip() for column in df.columns]
    return df


def to_number(series: pd.Series) -> pd.Series:
    cleaned = (
        series.astype("string")
        .str.replace(",", "", regex=False)
        .str.replace("원", "", regex=False)
        .str.replace(r"[^0-9.\-]", "", regex=True)
    )
    return pd.to_numeric(cleaned, errors="coerce")


def read_excel_file(path: Path) -> pd.DataFrame:
    df = pd.read_excel(path, dtype="string", engine="openpyxl")
    df = normalize_columns(df)

    missing_columns = [
        column
        for column in (FACTORY_CODE_COLUMN, ORDER_AMOUNT_COLUMN)
        if column not in df.columns
    ]
    if missing_columns:
        raise ValueError(
            f"{path.name}에 필수 컬럼이 없습니다: {', '.join(missing_columns)}"
        )

    df["_source_file"] = path.name
    return df


def filter_rows(df: pd.DataFrame) -> pd.DataFrame:
    factory_code = df[FACTORY_CODE_COLUMN].astype("string").str.strip()
    order_amount = to_number(df[ORDER_AMOUNT_COLUMN])

    mask = (factory_code == TARGET_FACTORY_CODE) & (order_amount > MIN_ORDER_AMOUNT)
    return df.loc[mask].copy()


def main() -> int:
    base_dir = Path(__file__).resolve().parent
    frames = []

    for file_name in INPUT_FILES:
        path = base_dir / file_name
        if not path.exists():
            raise FileNotFoundError(f"입력 파일을 찾을 수 없습니다: {path}")

        df = read_excel_file(path)
        filtered = filter_rows(df)
        frames.append(filtered)
        print(f"{path.name}: {len(df):,} rows -> {len(filtered):,} rows")

    merged = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    output_path = base_dir / OUTPUT_FILE
    merged.to_csv(output_path, index=False, encoding="utf-8-sig")

    print(f"saved: {output_path}")
    print(f"total rows: {len(merged):,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
