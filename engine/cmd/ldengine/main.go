// ldengine is LighterDeck's order engine: the automations of the deck and of the public site's visitors, close
// to Lighter. The Python server (backend/engine_go.py) starts it, sends it the keys and forwards the site's calls;
// it listens on 127.0.0.1 only and prints the address it got as "LISTEN host:port".
//
// Environment: LIGHTER_URL, DATA_DIR, ENGINE_TOKEN (required), ENGINE_LISTEN (default 127.0.0.1:0),
// MAX_SLIPPAGE_PCT, MAX_NOTIONAL_USD, MAX_ORDERS_PER_DAY. With ENGINE_STDIN_WATCH=1 it stops when its standard
// input closes, so it never outlives the Python server that started it.
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/telcoray/lighterdeck/engine/internal/feed"
	"github.com/telcoray/lighterdeck/engine/internal/lighter"
	"github.com/telcoray/lighterdeck/engine/internal/server"
)

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envFloat(name string, def float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(name), 64); err == nil {
		return v
	}
	return def
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	token := os.Getenv("ENGINE_TOKEN")
	if len(token) < 16 {
		fmt.Fprintln(os.Stderr, "ENGINE_TOKEN missing or too short")
		os.Exit(2)
	}
	dataDir := env("DATA_DIR", filepath.Join("..", "data"))
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if os.Getenv("ENGINE_STDIN_WATCH") == "1" {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}

	client := lighter.NewClient(lighter.Config{
		URL:            env("LIGHTER_URL", "https://mainnet.zklighter.elliot.ai"),
		MaxSlippagePct: envFloat("MAX_SLIPPAGE_PCT", 0.5),
		MaxNotional:    envFloat("MAX_NOTIONAL_USD", 0),
		MaxOrdersDay:   int(envFloat("MAX_ORDERS_PER_DAY", 0)),
	})
	for {
		err := client.LoadMarkets(ctx)
		if err == nil {
			break
		}
		slog.Warn("markets not loaded; retrying", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
	slog.Info("markets loaded", "count", len(client.Markets()))

	prices := feed.NewPrices(client.Multipliers)
	book := feed.NewBook(client.Multipliers)
	go prices.Run(ctx, client.WSURL())
	go book.Run(ctx, client.WSURL())

	host := server.NewHost(ctx, client, prices, book, dataDir, token)
	if err := host.StartDeck(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ln, err := net.Listen("tcp", env("ENGINE_LISTEN", "127.0.0.1:0"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("LISTEN %s\n", ln.Addr())
	srv := &http.Server{Handler: host.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
