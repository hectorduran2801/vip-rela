# muestrea memoria y CPU de los procesos de PostgreSQL de las pruebas
peak=0; cpu=0
while pgrep -f "vitest.*import5000" >/dev/null; do
  set -- $(ps -A -o rss=,pcpu=,command= | grep "[v]ip-pg-" -A0 | awk '{r+=$1;c+=$2} END {print int(r/1024), int(c)}'); m=${1:-0}; p=${2:-0}
  s=$(ps -A -o rss=,pcpu=,command= | grep -E "^ *[0-9]+ +[0-9.]+ +(/.*/)?postgres" | awk '{r+=$1;c+=$2} END {print int(r/1024), int(c)}'); set -- $s; m=${1:-0}; p=${2:-0}
  [ "$m" -gt "$peak" ] && peak=$m; [ "$p" -gt "$cpu" ] && cpu=$p; echo "pico_mem_MB=$peak pico_cpu=$cpu" > /tmp/vip-bench-watch.txt; sleep 5
done
