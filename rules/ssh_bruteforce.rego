package hids.rules.ssh_bruteforce

# name: SSH 暴力破解来源
# description: 登录类告警里来源 IP 非空、命令含 ssh 的，列为需要人工复核的候选

default match := false

match if {
  input.type == "abnormal_login"
  input.source_ip != ""
  contains(input.command, "ssh")
}
