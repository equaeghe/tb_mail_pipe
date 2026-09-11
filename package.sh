#!/usr/bin/env bash
# Builds tb_mail_pipe.xpi from addon/ (contents at the archive root,
# as Thunderbird requires).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/addon"
rm -f ../tb_mail_pipe.xpi
zip -r ../tb_mail_pipe.xpi . -x '*.DS_Store'
echo "Built tb_mail_pipe.xpi"
