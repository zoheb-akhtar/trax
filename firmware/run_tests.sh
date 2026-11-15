#!/bin/bash
# Every Velo test. Exit code 0 only if all pass.  ./run_tests.sh
cd "$(dirname "$0")"
PY=${PY:-.venv/bin/python}
[ -x "$PY" ] || PY=python3
[ -f testdata/drive.mp4 ] || ./tools/get_testdata.sh > /dev/null
fail=0
for t in test_perception_sim test_bike_lanes test_security_rides test_health test_real_footage; do
  out=$($PY tests/$t.py 2>&1); code=$?
  printf "%-24s %s\n" "$t" "$(echo "$out" | tail -1)"
  [ $code -eq 0 ] || { fail=1; echo "$out" | grep FAIL; }
done
exit $fail
