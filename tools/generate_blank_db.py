"""
Generate a blank database template for new deployments.

Usage:
    python tools/generate_blank_db.py [--output data/blank.db]
"""
import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from db.models import init_db


def main():
    parser = argparse.ArgumentParser(description='生成空白数据库模板')
    parser.add_argument('--output', '-o', default='data/blank.db',
                        help='输出数据库路径')
    args = parser.parse_args()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if output_path.exists():
        print(f"警告：文件已存在，将被覆盖: {output_path}")
        output_path.unlink()

    init_db(str(output_path))
    print(f"OK: {output_path}  ({output_path.stat().st_size} bytes)")


if __name__ == '__main__':
    main()
