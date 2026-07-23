package agenttoken

import (
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/liveagent/agent-gateway/internal/db"
)

const benchmarkAgentCount = 1000

func openBenchmarkStore(b *testing.B) *Store {
	b.Helper()
	database, err := db.Open(filepath.Join(b.TempDir(), "gateway.db"))
	if err != nil {
		b.Fatalf("open benchmark database: %v", err)
	}
	b.Cleanup(func() { _ = database.Close() })
	store, err := NewStore(database)
	if err != nil {
		b.Fatalf("open benchmark store: %v", err)
	}
	return store
}

func benchmarkAgentID(index int) string {
	return fmt.Sprintf("agent-00000000-0000-4000-8000-%012x", index)
}

func seedBenchmarkAgents(b *testing.B, store *Store, issueTokens bool) ([]string, []string) {
	b.Helper()
	ids := make([]string, benchmarkAgentCount)
	tokens := make([]string, benchmarkAgentCount)
	for index := range ids {
		ids[index] = benchmarkAgentID(index)
		if issueTokens {
			token, err := store.Issue(ids[index], "")
			if err != nil {
				b.Fatalf("issue benchmark token %d: %v", index, err)
			}
			tokens[index] = token
			continue
		}
		if err := store.Register(ids[index]); err != nil {
			b.Fatalf("register benchmark agent %d: %v", index, err)
		}
	}
	return ids, tokens
}

func BenchmarkOpenStorePreloads1000Agents(b *testing.B) {
	path := filepath.Join(b.TempDir(), "gateway.db")
	database, err := db.Open(path)
	if err != nil {
		b.Fatalf("open seed database: %v", err)
	}
	store, err := NewStore(database)
	if err != nil {
		_ = database.Close()
		b.Fatalf("open seed store: %v", err)
	}
	ids, _ := seedBenchmarkAgents(b, store, true)
	if err := database.Close(); err != nil {
		b.Fatalf("close seed database: %v", err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		database, err := db.Open(path)
		if err != nil {
			b.Fatalf("reopen benchmark database: %v", err)
		}
		store, err := NewStore(database)
		if err != nil {
			_ = database.Close()
			b.Fatalf("reopen benchmark store: %v", err)
		}
		if _, ok := store.knownAgents.Load(ids[0]); !ok {
			_ = database.Close()
			b.Fatal("first agent was not preloaded")
		}
		if _, ok := store.knownAgents.Load(ids[len(ids)-1]); !ok {
			_ = database.Close()
			b.Fatal("last agent was not preloaded")
		}
		if err := database.Close(); err != nil {
			b.Fatalf("close benchmark database: %v", err)
		}
	}
}

func BenchmarkAuthenticateAndRegisterSharedTokenCached(b *testing.B) {
	store := openBenchmarkStore(b)
	ids, _ := seedBenchmarkAgents(b, store, false)

	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		if _, err := store.AuthenticateAndRegister(ids[index%len(ids)], "", true); err != nil {
			b.Fatalf("authenticate shared token agent: %v", err)
		}
	}
}

func BenchmarkAuthenticateAndRegisterAgentToken(b *testing.B) {
	store := openBenchmarkStore(b)
	ids, tokens := seedBenchmarkAgents(b, store, true)

	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		agentIndex := index % len(ids)
		if _, err := store.AuthenticateAndRegister(ids[agentIndex], tokens[agentIndex], false); err != nil {
			b.Fatalf("authenticate independent agent token: %v", err)
		}
	}
}

func BenchmarkAuthenticateAndRegisterAgentTokenParallel(b *testing.B) {
	store := openBenchmarkStore(b)
	ids, tokens := seedBenchmarkAgents(b, store, true)
	var sequence atomic.Uint64

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			agentIndex := int(sequence.Add(1)-1) % len(ids)
			if _, err := store.AuthenticateAndRegister(ids[agentIndex], tokens[agentIndex], false); err != nil {
				b.Errorf("authenticate independent agent token: %v", err)
				return
			}
		}
	})
}

func benchmarkAuthenticate1000AgentsConcurrent(b *testing.B, sharedAuthenticated bool) {
	store := openBenchmarkStore(b)
	ids, tokens := seedBenchmarkAgents(b, store, !sharedAuthenticated)

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		b.StopTimer()
		start := make(chan struct{})
		errs := make([]error, len(ids))
		var ready sync.WaitGroup
		var done sync.WaitGroup
		ready.Add(len(ids))
		done.Add(len(ids))
		for index := range ids {
			go func() {
				defer done.Done()
				ready.Done()
				<-start
				_, errs[index] = store.AuthenticateAndRegister(
					ids[index], tokens[index], sharedAuthenticated,
				)
			}()
		}
		ready.Wait()
		b.StartTimer()
		close(start)
		done.Wait()
		b.StopTimer()

		for index, err := range errs {
			if err != nil {
				b.Fatalf("authenticate concurrent agent %d: %v", index, err)
			}
		}
	}
	elapsed := b.Elapsed()
	b.ReportMetric(
		float64(b.N*len(ids))/elapsed.Seconds(),
		"agents/s",
	)
	b.ReportMetric(
		float64(elapsed.Nanoseconds())/float64(b.N*len(ids)),
		"ns/agent",
	)
}

func BenchmarkAuthenticateAndRegister1000SharedTokenAgentsConcurrent(b *testing.B) {
	benchmarkAuthenticate1000AgentsConcurrent(b, true)
}

func BenchmarkAuthenticateAndRegister1000AgentTokensConcurrent(b *testing.B) {
	benchmarkAuthenticate1000AgentsConcurrent(b, false)
}

func BenchmarkRegister1000SharedTokenAgentsConcurrent(b *testing.B) {
	ids := make([]string, benchmarkAgentCount)
	for index := range ids {
		ids[index] = benchmarkAgentID(index)
	}
	tempDir := b.TempDir()

	b.ReportAllocs()
	b.ResetTimer()
	for iteration := range b.N {
		b.StopTimer()
		database, err := db.Open(filepath.Join(tempDir, fmt.Sprintf("gateway-%d.db", iteration)))
		if err != nil {
			b.Fatalf("open first-registration benchmark database: %v", err)
		}
		store, err := NewStore(database)
		if err != nil {
			_ = database.Close()
			b.Fatalf("open first-registration benchmark store: %v", err)
		}

		start := make(chan struct{})
		errs := make([]error, len(ids))
		var ready sync.WaitGroup
		var done sync.WaitGroup
		ready.Add(len(ids))
		done.Add(len(ids))
		for index := range ids {
			go func() {
				defer done.Done()
				ready.Done()
				<-start
				_, errs[index] = store.AuthenticateAndRegister(ids[index], "", true)
			}()
		}
		ready.Wait()
		b.StartTimer()
		close(start)
		done.Wait()
		b.StopTimer()

		for index, authErr := range errs {
			if authErr != nil {
				_ = database.Close()
				b.Fatalf("register concurrent shared-token agent %d: %v", index, authErr)
			}
		}
		if err := database.Close(); err != nil {
			b.Fatalf("close first-registration benchmark database: %v", err)
		}
	}
	elapsed := b.Elapsed()
	b.ReportMetric(float64(b.N*len(ids))/elapsed.Seconds(), "agents/s")
	b.ReportMetric(
		float64(elapsed.Nanoseconds())/float64(b.N*len(ids)),
		"ns/agent",
	)
}

func BenchmarkList1000Agents(b *testing.B) {
	store := openBenchmarkStore(b)
	ids, _ := seedBenchmarkAgents(b, store, true)
	onlineIDs := make([]string, 0, benchmarkAgentCount/2)
	for index := 0; index < len(ids); index += 2 {
		onlineIDs = append(onlineIDs, ids[index])
	}

	benchmarks := []struct {
		name   string
		params PageParams
	}{
		{name: "all_page_50", params: PageParams{Page: 1, PageSize: 50}},
		{
			name: "online_page_25",
			params: PageParams{
				Page:           1,
				PageSize:       25,
				Status:         StatusOnline,
				OnlineAgentIDs: onlineIDs,
			},
		},
		{
			name: "offline_page_25",
			params: PageParams{
				Page:           1,
				PageSize:       25,
				Status:         StatusOffline,
				OnlineAgentIDs: onlineIDs,
			},
		},
	}

	for _, benchmark := range benchmarks {
		b.Run(benchmark.name, func(b *testing.B) {
			b.ReportAllocs()
			for range b.N {
				page, err := store.List(benchmark.params)
				if err != nil {
					b.Fatalf("list benchmark agents: %v", err)
				}
				if len(page.Entries) != benchmark.params.PageSize {
					b.Fatalf("listed %d entries, want %d", len(page.Entries), benchmark.params.PageSize)
				}
			}
		})
	}
}
