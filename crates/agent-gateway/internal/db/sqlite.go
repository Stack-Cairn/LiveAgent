package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// openSQLite 打开内嵌 SQLite 连接池。WAL 让读写不互斥，busy_timeout 让偶发写
// 冲突等待重试；文件收紧到 0600（默认 0644，库内含凭证哈希等敏感数据）。
func openSQLite(path string) (*sql.DB, error) {
	if dir := filepath.Dir(path); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("create sqlite directory: %w", err)
		}
	}
	pool, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite 写天然单写者串行、读走 WAL 并行；4 足够覆盖握手校验 + 管理 API 的并发面。
	pool.SetMaxOpenConns(4)
	pool.SetMaxIdleConns(4)
	// sql.Open 惰性建连；Ping 强制创建库文件，chmod 才有目标。
	if err := pool.Ping(); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("chmod sqlite file: %w", err)
	}
	return pool, nil
}
