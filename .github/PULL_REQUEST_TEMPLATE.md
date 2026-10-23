## 这个 PR 做了什么

<!-- 一句话说清。如果是修 bug，附上 Issue 编号 -->

## 改动范围

- [ ] 面板后端（`server.js` / `lib/`）
- [ ] 前端（`public/`）
- [ ] agent（`agent/agent.sh`）
- [ ] 数据库 schema（**必须**说明迁移与回滚方式）
- [ ] 文档 / 测试

## 怎么验证的

<!-- 贴命令与结果。跑过哪些测试？手动点了哪些页面？ -->

```bash
node test/renew.js
node test/security.js
PANEL_ADMIN_PASSWORD=test-pass-123 node test/smoke.js http://127.0.0.1:8080
```

## 兼容性

- [ ] 不影响老库升级（只做加法、`SCHEMA_VERSION` 已递增）
- [ ] 不破坏已有接口字段与 agent 下发协议
- [ ] 没有引入运行时依赖（依赖必须为空）
- [ ] 前端仍是零构建（经典脚本，无 `import`）

## 截图

<!-- 界面改动请附前后对比 -->
