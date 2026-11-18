package hids.rules.webshell_drop

# name: WebShell 落地脚本
# description: webshell 告警落在 /tmp 下、路径以 .jsp 结尾，且主机非空

default match := false

match if {
  input.type == "webshell"
  input.host != ""
  startswith(input.path, "/tmp/")
  endswith(input.path, ".jsp")
}
