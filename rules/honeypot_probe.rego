package hids.rules.honeypot_probe

# name: 蜜罐探测（root 用户）
# description: 蜜罐类型告警，对端与来源 IP 都非空、用户为 root 的探测

default match := false

match if {
  input.type == "honeypot"
  input.peer != ""
  input.source_ip != ""
  input.user == "root"
}
