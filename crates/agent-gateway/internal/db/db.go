// Package db 管理网关共享的数据库连接池：各持久化子系统在同一池上建各自的表，
// 避免对同一库开多个池放大锁冲突。当前后端为内嵌 SQLite，后端切换在 Open 分发。
package db

import (
	"database/sql"
	"errors"
	"strings"
)

// DB 是 Gateway 共享连接池句柄。
type DB struct {
	pool *sql.DB
}

// Open 打开连接池；DSN 为空直接报错，Gateway 不提供关闭持久化的模式。目前仅
// 支持 SQLite（DSN 即文件路径），后端扩展（如 PostgreSQL）在此按 DSN 分发。
func Open(dsn string) (*DB, error) {
	dsn = strings.TrimSpace(dsn)
	if dsn == "" {
		return nil, errors.New("gateway database path is required")
	}
	pool, err := openSQLite(dsn)
	if err != nil {
		return nil, err
	}
	return &DB{pool: pool}, nil
}

func (d *DB) Enabled() bool {
	return d != nil
}

// Pool 返回底层连接池供子系统建表与查询；生命周期归本包，调用方不得 Close。
func (d *DB) Pool() *sql.DB {
	if d == nil {
		return nil
	}
	return d.pool
}

func (d *DB) Close() error {
	if d == nil {
		return nil
	}
	return d.pool.Close()
}
