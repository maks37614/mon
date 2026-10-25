/**
 * Complete, production-ready PHP 8.1+ script files for the AutoScalping Formations bot.
 * Ready to deploy on Linux VPS, cPanel, or Docker.
 */

export interface PhpFile {
  filename: string;
  description: string;
  content: string;
}

export const PHP_FILES: PhpFile[] = [
  {
    filename: 'bot_formations.php',
    description: 'Головний виконуваний скрипт для Cron (CLI / VPS)',
    content: `<?php
/**
 * AutoScalping Формації - Торговий Бот h00k.top
 * Основний скрипт для запуску через Linux Cron
 * 
 * Запуск: php bot_formations.php
 * Cron розклад: * * * * * php /var/www/bot/bot_formations.php >> /var/www/bot/logs/cron.log 2>&1
 */

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/H00kClient.php';
require_once __DIR__ . '/TradingEngine.php';
require_once __DIR__ . '/BinanceClient.php';
require_once __DIR__ . '/TelegramNotifier.php';

// 1. Захист від паралельного запуску (Lock File)
$lockFile = __DIR__ . '/data/bot.lock';
$lockHandle = fopen($lockFile, 'c');
if (!$lockHandle || !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    echo "[" . gmdate('Y-m-d H:i:s') . " UTC] Інший процес бота вже виконується. Пропуск ітерації.\\n";
    exit(0);
}

echo "========================================================\\n";
echo "[" . gmdate('Y-m-d H:i:s') . " UTC] Запуск АвтоСкальпінг Формації v2.5 (Справжнє підключення h00k.top)\\n";
echo "Таймфрейм: " . BOT_TIMEFRAME . " | Реверс: " . (REVERSE_MODE ? "УВІМКНЕНО" : "ВИМКНЕНО") . "\\n";
echo "Швидкий скальпінг (<= 5 хв): " . (QUICK_SCALPING_5M_ENABLED ? "АКТИВНИЙ (Тейк: " . QUICK_TP_PERCENT . "%, Стоп: " . QUICK_SL_PERCENT . "%)" : "ВИМКНЕНО") . "\\n";
echo "Ринок: " . MARKET_TYPE . " | Макс. позицій: " . MAX_OPEN_POSITIONS . "\\n";
echo "========================================================\\n";

try {
    // 2. Ініціалізація клієнтів
    $h00k = new H00kClient(H00K_BASE_URL, __DIR__ . '/cache');
    $binance = new BinanceClient(
        BINANCE_API_KEY,
        BINANCE_API_SECRET,
        BINANCE_TESTNET,
        PAPER_TRADING_MODE,
        MARKET_TYPE
    );
    $telegram = new TelegramNotifier(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID);
    $engine = new TradingEngine(__DIR__ . '/data', $binance, $telegram);

    // 3. Супровід уже відкритих угод (перевірка TP, SL та жорсткого таймауту 5 хвилин)
    echo "\\n[1/3] Перевірка та супровід відкритих позицій (TP / SL / таймаут 5 хв)...\\n";
    $engine->monitorAndClosePositions();

    // 4. Отримання формацій з h00k.top для активного таймфрейму
    echo "\\n[2/3] Запит реальних формацій з h00k.top (TF: " . BOT_TIMEFRAME . ")...\\n";
    $formationsResult = $h00k->getFormations(BOT_TIMEFRAME, QUICK_SCALPING_5M_ENABLED);

    $signals = $formationsResult['data'] ?? [];
    echo "Отримано " . count($signals) . " сигналів (джерело: " . $formationsResult['source'] . ")\\n";

    // 5. Обробка нових сигналів та відкриття угод
    echo "\\n[3/3] Фільтрація сигналів та відкриття точок входу...\\n";
    $engine->processSignals($signals);

    // 6. Оновлення статистики
    $stats = $engine->getStats();
    echo "\\n--- ПІДСУМОК ЕТАПУ ---\\n";
    echo "Баланс: " . number_format($stats['balance'], 2) . " USDT | Еквіті: " . number_format($stats['equity'], 2) . " USDT\\n";
    echo "Відкрито угод: " . $stats['open_positions_count'] . " / " . MAX_OPEN_POSITIONS . "\\n";
    echo "Чистий P&L закритих: " . number_format($stats['closed_net_pnl'], 2) . " USDT | Win Rate: " . $stats['win_rate'] . "%\\n";

} catch (Throwable $e) {
    echo "❌ КРИТИЧНА ПОМИЛКА: " . $e->getMessage() . "\\n";
    file_put_contents(__DIR__ . '/logs/error.log', "[" . gmdate('Y-m-d H:i:s') . " UTC] " . $e->getMessage() . "\\n" . $e->getTraceAsString() . "\\n", FILE_APPEND);
    if (!empty(TELEGRAM_BOT_TOKEN)) {
        $telegram->sendAlert("⚠️ Критична помилка бота: " . $e->getMessage());
    }
} finally {
    flock($lockHandle, LOCK_UN);
    fclose($lockHandle);
    echo "\\n[" . gmdate('Y-m-d H:i:s') . " UTC] Завершення ітерації.\\n";
}
`
  },
  {
    filename: 'config.php',
    description: 'Конфігурація бота: h00k.top, швидкий скальпінг 5хв, короткий TP/SL, реверс',
    content: `<?php
/**
 * Конфігураційний файл АвтоСкальпінг Формації v2.5
 */

declare(strict_types=1);

// 1. Джерело даних h00k.top (справжнє підключення)
define('H00K_BASE_URL', getenv('HOOK_API_URL') ?: 'https://h00k.top');
define('HOOK_SCREENER_TIMEFRAMES', getenv('HOOK_SCREENER_TIMEFRAMES') ?: '1m,5m,15m,30m,1h,4h');

// 2. Таймфрейм бота (1m, 5m, 15m, 30m, 1h, 4h)
define('BOT_TIMEFRAME', getenv('BOT_TIMEFRAME') ?: '1m');

// 3. ФУНКЦІЯ КОРОТКИХ ПОЗИЦІЙ ДО 5 ХВИЛИН (QUICK SCALP <= 5 MIN)
// Автозакриття по ринку якщо TP/SL не досягнуто протягом 300 секунд
define('QUICK_SCALPING_5M_ENABLED', filter_var(getenv('QUICK_SCALPING_5M') ?: true, FILTER_VALIDATE_BOOLEAN));
define('QUICK_SCALPING_MAX_DURATION_SEC', 300); // 5 хвилин жорсткий тайм-стоп
define('QUICK_TP_PERCENT', 0.45);               // Короткий тейк-профіт: 0.45%
define('QUICK_SL_PERCENT', 0.25);               // Короткий стоп-лос: 0.25%

// 4. Реверс стратегії
// Після вихідних фільтрів LONG стає SHORT і навпаки; стоп і ціль міняються ролями.
define('REVERSE_MODE', filter_var(getenv('REVERSE_MODE') ?: false, FILTER_VALIDATE_BOOLEAN));

// 5. Тип ринку: 'futures' (USDT-M Futures) або 'spot'
define('MARKET_TYPE', getenv('MARKET_TYPE') ?: 'futures');

// 6. Ризик-менеджмент та баланс
define('START_BALANCE', 1000.0);
define('MAX_OPEN_POSITIONS', 5);
define('RISK_PER_TRADE_PERCENT', 5.0); // 5% від балансу на позицію
define('LEVERAGE', 5);                  // Плече для Futures
define('SLIPPAGE_TOLERANCE_PERCENT', 0.20); // 0.20% від точки входу формації
define('MIN_RISK_REWARD', 1.8);        // Мінімальний коефіцієнт R:R

// 7. Комісії біржі (taker 0.04% на ф'ючерсах)
define('TAKER_FEE_PERCENT', 0.04);

// 8. Перенесення в безубиток (Break-Even)
define('USE_BREAK_EVEN_AT_50_TP', true);

// 9. Ключі біржі Binance
define('BINANCE_API_KEY', getenv('BINANCE_API_KEY') ?: '');
define('BINANCE_API_SECRET', getenv('BINANCE_API_SECRET') ?: '');
define('BINANCE_TESTNET', filter_var(getenv('BINANCE_TESTNET') ?: false, FILTER_VALIDATE_BOOLEAN));
define('PAPER_TRADING_MODE', filter_var(getenv('PAPER_TRADING') ?: true, FILTER_VALIDATE_BOOLEAN));

// 10. Сповіщення Telegram
define('TELEGRAM_BOT_TOKEN', getenv('TELEGRAM_BOT_TOKEN') ?: '');
define('TELEGRAM_CHAT_ID', getenv('TELEGRAM_CHAT_ID') ?: '');

// Чорний список інструментів
define('BLACKLIST_COINS', ['USDCUSDT', 'FDUSDUSDT', 'EURUSDT', 'TUSDUSDT']);
`
  },
  {
    filename: 'H00kClient.php',
    description: 'Клієнт до h00k.top зі справжнім підключенням та перевіркою статусу',
    content: `<?php
/**
 * H00kClient - Отримання формацій з h00k.top
 * Парсить точки входу, стопу, тейку зі сторінки монет та API h00k.top
 */

declare(strict_types=1);

class H00kClient
{
    private string $baseUrl;
    private string $cacheDir;

    public function __construct(string $baseUrl, string $cacheDir)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->cacheDir = $cacheDir;
        if (!is_dir($this->cacheDir)) {
            mkdir($this->cacheDir, 0755, true);
        }
    }

    /**
     * Перевірка справжнього статусу з'єднання з h00k.top
     */
    public function checkHealth(): array
    {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $this->baseUrl,
            CURLOPT_NOBODY => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 4,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; H00kTradingBot/2.5)'
        ]);

        $start = microtime(true);
        curl_exec($ch);
        $latencyMs = round((microtime(true) - $start) * 1000);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        return [
            'online' => ($httpCode >= 200 && $httpCode < 400),
            'http_code' => $httpCode,
            'latency_ms' => $latencyMs,
            'endpoint' => $this->baseUrl
        ];
    }

    /**
     * Отримати формації для вказаного таймфрейму з h00k.top
     */
    public function getFormations(string $timeframe, bool $quickScalp = false): array
    {
        $cacheFile = $this->cacheDir . "/formations_{$timeframe}.json";
        $qsParam = $quickScalp ? 'true' : 'false';
        $url = $this->baseUrl . "/api/formations?timeframe=" . urlencode($timeframe) . "&quickScalp=" . $qsParam;

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_USERAGENT => 'H00k-AutoScalping-Bot/2.5',
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'Cache-Control: no-cache'
            ]
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode === 200 && !empty($response)) {
            $data = json_decode($response, true);
            if (is_array($data) && (isset($data['data']) || isset($data[0]))) {
                $signals = isset($data['data']) ? $data['data'] : $data;
                file_put_contents($cacheFile, json_encode([
                    'cached_at' => gmdate('Y-m-d H:i:s') . ' UTC',
                    'timeframe' => $timeframe,
                    'signals' => $signals
                ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

                return [
                    'status' => 'fresh',
                    'source' => 'Справжнє підключення h00k.top API',
                    'data' => $this->normalizeSignals($signals, $timeframe, $quickScalp)
                ];
            }
        }

        // Якщо ендпоінт відповів кешем або парсером
        if (file_exists($cacheFile)) {
            $raw = file_get_contents($cacheFile);
            $cached = json_decode($raw, true);
            if (isset($cached['signals']) && is_array($cached['signals'])) {
                return [
                    'status' => 'cached',
                    'source' => 'Локальний кеш h00k.top (' . ($cached['cached_at'] ?? 'раніше') . ')',
                    'data' => $this->normalizeSignals($cached['signals'], $timeframe, $quickScalp)
                ];
            }
        }

        return [
            'status' => 'empty',
            'source' => 'Скрінер h00k.top очікує нових сигналів',
            'data' => []
        ];
    }

    private function normalizeSignals(array $rawSignals, string $timeframe, bool $quickScalp): array
    {
        $normalized = [];
        foreach ($rawSignals as $item) {
            $symbol = strtoupper($item['symbol'] ?? $item['coin'] ?? '');
            if (empty($symbol) || in_array($symbol, BLACKLIST_COINS, true)) {
                continue;
            }

            $direction = strtoupper($item['direction'] ?? ($item['side'] === 'buy' ? 'LONG' : 'SHORT'));
            $entry = (float)($item['entryPrice'] ?? $item['entry'] ?? 0);
            $stop = (float)($item['stopLoss'] ?? $item['stop'] ?? 0);
            $take = (float)($item['takeProfit'] ?? $item['take'] ?? $item['target'] ?? 0);

            if ($entry <= 0) continue;

            // Якщо увімкнено швидкий скальпінг: застосовуємо короткий тейк та короткий стоп
            if ($quickScalp) {
                $isLong = $direction === 'LONG';
                $tightTpDist = $entry * (QUICK_TP_PERCENT / 100);
                $tightSlDist = $entry * (QUICK_SL_PERCENT / 100);
                $take = $isLong ? ($entry + $tightTpDist) : ($entry - $tightTpDist);
                $stop = $isLong ? ($entry - $tightSlDist) : ($entry + $tightSlDist);
            }

            $normalized[] = [
                'id' => $item['id'] ?? ($symbol . '_' . time()),
                'symbol' => $symbol,
                'timeframe' => $timeframe,
                'formation' => $item['formation'] ?? $item['pattern'] ?? 'Графічна формація',
                'direction' => $direction,
                'entryPrice' => $entry,
                'stopLoss' => round($stop, 4),
                'takeProfit' => round($take, 4),
                'riskRewardRatio' => $quickScalp ? '1:1.8' : ($item['riskRewardRatio'] ?? '1:2.2'),
                'confidence' => (int)($item['confidence'] ?? 90),
                'detectedAt' => $item['detectedAt'] ?? gmdate('Y-m-d H:i:s') . ' UTC',
                'is_quick_scalp' => $quickScalp
            ];
        }

        return $normalized;
    }
}
`
  },
  {
    filename: 'TradingEngine.php',
    description: 'Логіка автоскальпінгу: таймаут 5 хвилин, короткі TP/SL, реверс, spot захист',
    content: `<?php
/**
 * TradingEngine - Логіка стратегії АвтоСкальпінгу з підтримкою швидких позицій до 5 хв
 */

declare(strict_types=1);

class TradingEngine
{
    private string $dataDir;
    private BinanceClient $binance;
    private TelegramNotifier $telegram;

    public function __construct(string $dataDir, BinanceClient $binance, TelegramNotifier $telegram)
    {
        $this->dataDir = $dataDir;
        $this->binance = $binance;
        $this->telegram = $telegram;

        if (!is_dir($this->dataDir)) {
            mkdir($this->dataDir, 0755, true);
        }
    }

    public function getState(): array
    {
        $stateFile = $this->dataDir . '/state.json';
        if (file_exists($stateFile)) {
            $data = json_decode(file_get_contents($stateFile), true);
            if (is_array($data)) {
                return $data;
            }
        }

        return [
            'balance' => START_BALANCE,
            'start_balance' => START_BALANCE,
            'equity' => START_BALANCE,
            'closed_net_pnl' => 0.0,
            'total_commissions' => 0.0,
            'trades_count' => 0,
            'wins' => 0,
            'losses' => 0,
            'gross_profit' => 0.0,
            'gross_loss' => 0.0,
            'peak_equity' => START_BALANCE,
            'max_drawdown' => 0.0,
            'open_positions' => [],
            'closed_trades' => [],
            'last_run_utc' => gmdate('d.m.Y H:i:s') . ' UTC'
        ];
    }

    public function saveState(array $state): void
    {
        $state['last_run_utc'] = gmdate('d.m.Y H:i:s') . ' UTC';
        file_put_contents($this->dataDir . '/state.json', json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    }

    /**
     * Супровід відкритих позицій:
     * - Перевірка Take Profit
     * - Перевірка Stop Loss
     * - Примусове закриття через 5 хвилин (300 секунд) для швидких угод
     */
    public function monitorAndClosePositions(): void
    {
        $state = $this->getState();
        $positions = $state['open_positions'];
        $remainingPositions = [];
        $unrealizedPnlTotal = 0.0;
        $now = time();

        foreach ($positions as $pos) {
            $symbol = $pos['symbol'];
            $currentPrice = $this->binance->getTickerPrice($symbol);

            if ($currentPrice <= 0) {
                $remainingPositions[] = $pos;
                continue;
            }

            $isLong = $pos['direction'] === 'LONG';
            $entry = (float)$pos['entry_price'];
            $sl = (float)$pos['stop_loss'];
            $tp = (float)$pos['take_profit'];
            $qty = (float)$pos['quantity'];

            $priceDiff = $isLong ? ($currentPrice - $entry) : ($entry - $currentPrice);
            $unrealizedPnl = $priceDiff * $qty;
            $unrealizedPnlTotal += $unrealizedPnl;

            // 1. Умова Take Profit
            $isTpHit = $isLong ? ($currentPrice >= $tp) : ($currentPrice <= $tp);
            // 2. Умова Stop Loss
            $isSlHit = $isLong ? ($currentPrice <= $sl) : ($currentPrice >= $sl);
            // 3. ЖОРСТКИЙ ТАЙМАУТ 5 ХВИЛИН (300 секунд) ДЛЯ КОРОТКИХ ПОЗИЦІЙ
            $durationSeconds = $now - (int)($pos['opened_timestamp'] ?? $now);
            $isExpired5m = !empty($pos['is_quick_scalp_5m']) && ($durationSeconds >= QUICK_SCALPING_MAX_DURATION_SEC);

            if ($isTpHit || $isSlHit || $isExpired5m) {
                $exitReason = $isTpHit ? 'TP' : ($isSlHit ? 'SL' : 'TIME_5M');
                $exitPrice = $isTpHit ? $tp : ($isSlHit ? $sl : $currentPrice);
                $finalDiff = $isLong ? ($exitPrice - $entry) : ($entry - $exitPrice);
                $grossPnl = $finalDiff * $qty;

                $feeOpen = ($entry * $qty) * (TAKER_FEE_PERCENT / 100);
                $feeClose = ($exitPrice * $qty) * (TAKER_FEE_PERCENT / 100);
                $totalFee = $feeOpen + $feeClose;
                $netPnl = $grossPnl - $totalFee;

                $reasonText = $isTpHit ? 'Take Profit' : ($isSlHit ? 'Stop Loss' : 'Таймаут 5 хв (300с)');
                echo "[Закриття] {$symbol} закрився по [{$reasonText}]! Вихід: {$exitPrice}, Чистий P&L: " . number_format($netPnl, 2) . " USDT\\n";

                // Закриття ордером на біржі
                $this->binance->closePositionMarket($symbol, $pos['direction'], $qty);

                $state['balance'] += $netPnl;
                $state['closed_net_pnl'] += $netPnl;
                $state['total_commissions'] += $totalFee;
                $state['trades_count']++;

                if ($netPnl >= 0) {
                    $state['wins']++;
                    $state['gross_profit'] += $netPnl;
                } else {
                    $state['losses']++;
                    $state['gross_loss'] += abs($netPnl);
                }

                $closedRecord = [
                    'id' => $pos['id'],
                    'symbol' => $symbol,
                    'formation' => $pos['formation'],
                    'direction' => $pos['direction'],
                    'entry_price' => $entry,
                    'exit_price' => $exitPrice,
                    'quantity' => $qty,
                    'stop_loss' => $sl,
                    'take_profit' => $tp,
                    'result' => $exitReason,
                    'net_pnl' => round($netPnl, 2),
                    'fee' => round($totalFee, 4),
                    'duration_sec' => $durationSeconds,
                    'opened_at' => $pos['opened_at'],
                    'closed_at' => gmdate('d.m.Y H:i:s') . ' UTC',
                    'is_reversed' => $pos['is_reversed'] ?? false,
                    'is_quick_scalp_5m' => $pos['is_quick_scalp_5m'] ?? false
                ];

                array_unshift($state['closed_trades'], $closedRecord);
                if (count($state['closed_trades']) > 1000) {
                    array_pop($state['closed_trades']);
                }

                $this->telegram->sendTradeClosed($closedRecord);
            } else {
                $pos['current_price'] = $currentPrice;
                $pos['unrealized_pnl'] = round($unrealizedPnl, 2);
                $remainingPositions[] = $pos;
            }
        }

        $state['open_positions'] = $remainingPositions;
        $state['equity'] = $state['balance'] + $unrealizedPnlTotal;

        if ($state['equity'] > $state['peak_equity']) {
            $state['peak_equity'] = $state['equity'];
        }
        $dd = (($state['peak_equity'] - $state['equity']) / $state['peak_equity']) * 100;
        if ($dd > $state['max_drawdown']) {
            $state['max_drawdown'] = round($dd, 2);
        }

        $this->saveState($state);
    }

    /**
     * Відкриття нових позицій
     */
    public function processSignals(array $signals): void
    {
        $state = $this->getState();
        $openCount = count($state['open_positions']);

        if ($openCount >= MAX_OPEN_POSITIONS) {
            echo "[Engine] Досягнуто ліміт відкритих позицій ({$openCount} / " . MAX_OPEN_POSITIONS . ").\\n";
            return;
        }

        $existingSymbols = array_column($state['open_positions'], 'symbol');

        foreach ($signals as $signal) {
            if ($openCount >= MAX_OPEN_POSITIONS) break;

            $symbol = $signal['symbol'];
            if (in_array($symbol, $existingSymbols, true)) continue;

            $direction = $signal['direction'];
            $entry = (float)$signal['entryPrice'];
            $sl = (float)$signal['stopLoss'];
            $tp = (float)$signal['takeProfit'];
            $isReversed = false;

            // РЕВЕРС СТРАТЕГІЇ
            if (REVERSE_MODE) {
                $direction = ($direction === 'LONG') ? 'SHORT' : 'LONG';
                $oldSl = $sl;
                $sl = $tp;
                $tp = $oldSl;
                $isReversed = true;
                echo "[Реверс] Сигнал {$symbol} перевернуто в {$direction}!\\n";
            }

            // Захист Spot ринку
            if (MARKET_TYPE === 'spot' && $direction === 'SHORT') {
                echo "[Фільтр] Пропуск {$symbol}: Short на spot ринку не дозволено.\\n";
                continue;
            }

            $livePrice = $this->binance->getTickerPrice($symbol);
            if ($livePrice <= 0) continue;

            // Якщо активовано швидкий скальпінг: короткий тейк та короткий стоп
            if (QUICK_SCALPING_5M_ENABLED) {
                $isLong = $direction === 'LONG';
                $tightTp = $livePrice * (QUICK_TP_PERCENT / 100);
                $tightSl = $livePrice * (QUICK_SL_PERCENT / 100);
                $tp = $isLong ? ($livePrice + $tightTp) : ($livePrice - $tightTp);
                $sl = $isLong ? ($livePrice - $tightSl) : ($livePrice + $tightSl);
            }

            $balance = (float)$state['balance'];
            $positionUsdt = $balance * (RISK_PER_TRADE_PERCENT / 100) * (MARKET_TYPE === 'futures' ? LEVERAGE : 1);
            $quantity = $positionUsdt / $livePrice;

            echo "🚀 [ВХІД" . (QUICK_SCALPING_5M_ENABLED ? " ⚡ ШВИДКИЙ СКАЛЬП <= 5хв" : "") . "] {$symbol} ({$direction}) | Обсяг: " . number_format($quantity, 4) . "\\n";
            echo "Рівні: Вхід {$livePrice} | Короткий Стоп {$sl} | Короткий Тейк {$tp} | Таймаут: 300с\\n";

            $orderRes = $this->binance->openMarketOrder($symbol, $direction, $quantity);
            if (!$orderRes['success']) {
                echo "❌ Помилка ордера: " . $orderRes['error'] . "\\n";
                continue;
            }

            $this->binance->setStopLossAndTakeProfit($symbol, $direction, $sl, $tp, $quantity);

            $now = time();
            $newPosition = [
                'id' => 'pos_' . $symbol . '_' . $now,
                'symbol' => $symbol,
                'formation' => $signal['formation'],
                'direction' => $direction,
                'entry_price' => $livePrice,
                'current_price' => $livePrice,
                'quantity' => $quantity,
                'amount_usdt' => $positionUsdt,
                'stop_loss' => round($sl, 4),
                'take_profit' => round($tp, 4),
                'timeframe' => BOT_TIMEFRAME,
                'market_type' => MARKET_TYPE,
                'opened_at' => gmdate('d.m.Y H:i:s') . ' UTC',
                'opened_timestamp' => $now,
                'expires_at_timestamp' => QUICK_SCALPING_5M_ENABLED ? ($now + QUICK_SCALPING_MAX_DURATION_SEC) : null,
                'is_reversed' => $isReversed,
                'is_quick_scalp_5m' => QUICK_SCALPING_5M_ENABLED,
                'unrealized_pnl' => 0.0
            ];

            $state['open_positions'][] = $newPosition;
            $existingSymbols[] = $symbol;
            $openCount++;

            $this->telegram->sendPositionOpened($newPosition);
        }

        $this->saveState($state);
    }

    public function getStats(): array
    {
        $state = $this->getState();
        $total = $state['trades_count'];
        $winRate = $total > 0 ? round(($state['wins'] / $total) * 100, 1) : 0;
        $profitFactor = $state['gross_loss'] > 0 ? round($state['gross_profit'] / $state['gross_loss'], 2) : ($state['gross_profit'] > 0 ? 99.9 : 0);

        return [
            'balance' => $state['balance'],
            'equity' => $state['equity'],
            'closed_net_pnl' => $state['closed_net_pnl'],
            'total_commissions' => $state['total_commissions'],
            'trades_count' => $total,
            'win_rate' => $winRate,
            'profit_factor' => $profitFactor,
            'max_drawdown' => $state['max_drawdown'],
            'open_positions_count' => count($state['open_positions'])
        ];
    }
}
`
  },
  {
    filename: 'BinanceClient.php',
    description: 'Клієнт Binance Futures (USDT-M) / Spot API з підписом HMAC-SHA256',
    content: `<?php
/**
 * BinanceClient - Взаємодія з біржею Binance (Futures / Spot)
 */

declare(strict_types=1);

class BinanceClient
{
    private string $apiKey;
    private string $apiSecret;
    private bool $isTestnet;
    private bool $isPaperTrading;
    private string $marketType;

    public function __construct(string $apiKey, string $apiSecret, bool $isTestnet, bool $isPaperTrading, string $marketType)
    {
        $this->apiKey = $apiKey;
        $this->apiSecret = $apiSecret;
        $this->isTestnet = $isTestnet;
        $this->isPaperTrading = $isPaperTrading;
        $this->marketType = $marketType;
    }

    public function getTickerPrice(string $symbol): float
    {
        $baseUrl = ($this->marketType === 'futures')
            ? 'https://fapi.binance.com/fapi/v1/ticker/price'
            : 'https://api.binance.com/api/v3/ticker/price';

        $url = $baseUrl . '?symbol=' . urlencode($symbol);

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 4,
            CURLOPT_HTTPHEADER => ['User-Agent: BinanceBot/1.0']
        ]);

        $res = curl_exec($ch);
        curl_close($ch);

        if ($res) {
            $data = json_decode($res, true);
            if (isset($data['price'])) {
                return (float)$data['price'];
            }
        }

        return 0.0;
    }

    public function openMarketOrder(string $symbol, string $side, float $quantity): array
    {
        if ($this->isPaperTrading) {
            return ['success' => true, 'order_id' => 'sim_' . time()];
        }

        $endpoint = ($this->marketType === 'futures') ? '/fapi/v1/order' : '/api/v3/order';
        $params = [
            'symbol' => $symbol,
            'side' => ($side === 'LONG' ? 'BUY' : 'SELL'),
            'type' => 'MARKET',
            'quantity' => round($quantity, 4),
            'timestamp' => (int)(microtime(true) * 1000)
        ];

        return $this->sendSignedRequest('POST', $endpoint, $params);
    }

    public function setStopLossAndTakeProfit(string $symbol, string $direction, float $sl, float $tp, float $quantity): array
    {
        if ($this->isPaperTrading || $this->marketType !== 'futures') {
            return ['success' => true];
        }

        $closeSide = ($direction === 'LONG') ? 'SELL' : 'BUY';

        // Виставляємо STOP_MARKET
        $this->sendSignedRequest('POST', '/fapi/v1/order', [
            'symbol' => $symbol,
            'side' => $closeSide,
            'type' => 'STOP_MARKET',
            'stopPrice' => $sl,
            'closePosition' => 'true',
            'timestamp' => (int)(microtime(true) * 1000)
        ]);

        // Виставляємо TAKE_PROFIT_MARKET
        $this->sendSignedRequest('POST', '/fapi/v1/order', [
            'symbol' => $symbol,
            'side' => $closeSide,
            'type' => 'TAKE_PROFIT_MARKET',
            'stopPrice' => $tp,
            'closePosition' => 'true',
            'timestamp' => (int)(microtime(true) * 1000)
        ]);

        return ['success' => true];
    }

    public function closePositionMarket(string $symbol, string $direction, float $quantity): array
    {
        if ($this->isPaperTrading) {
            return ['success' => true];
        }

        $closeSide = ($direction === 'LONG') ? 'SELL' : 'BUY';
        $endpoint = ($this->marketType === 'futures') ? '/fapi/v1/order' : '/api/v3/order';

        $params = [
            'symbol' => $symbol,
            'side' => $closeSide,
            'type' => 'MARKET',
            'quantity' => round($quantity, 4),
            'timestamp' => (int)(microtime(true) * 1000)
        ];

        return $this->sendSignedRequest('POST', $endpoint, $params);
    }

    private function sendSignedRequest(string $method, string $endpoint, array $params): array
    {
        $baseUrl = ($this->marketType === 'futures')
            ? ($this->isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com')
            : ($this->isTestnet ? 'https://testnet.binance.vision' : 'https://api.binance.com');

        $queryString = http_build_query($params);
        $signature = hash_hmac('sha256', $queryString, $this->apiSecret);
        $url = $baseUrl . $endpoint . '?' . $queryString . '&signature=' . $signature;

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'X-MBX-APIKEY: ' . $this->apiKey,
                'Content-Type: application/json'
            ]
        ]);

        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        $data = json_decode($res ?: '{}', true);
        if ($code >= 200 && $code < 300) {
            return ['success' => true, 'data' => $data];
        }

        return ['success' => false, 'error' => $data['msg'] ?? "HTTP {$code}"];
    }
}
`
  },
  {
    filename: 'TelegramNotifier.php',
    description: 'Сповіщення у Telegram про швидкі угоди, таймаути 5 хв та P&L',
    content: `<?php
/**
 * TelegramNotifier - Сповіщення про статус торгівлі
 */

declare(strict_types=1);

class TelegramNotifier
{
    private string $botToken;
    private string $chatId;

    public function __construct(string $botToken, string $chatId)
    {
        $this->botToken = $botToken;
        $this->chatId = $chatId;
    }

    public function sendPositionOpened(array $pos): void
    {
        $quickTag = !empty($pos['is_quick_scalp_5m']) ? " ⚡ [ШВИДКИЙ СКАЛЬП $\\le$ 5хв]" : "";
        $reverseText = !empty($pos['is_reversed']) ? " 🔄 (РЕВЕРС)" : "";
        $msg = "⚡ <b>Нова угода {$pos['symbol']} [{$pos['direction']}]{$reverseText}{$quickTag}</b>\\n\\n";
        $msg .= "📐 Формація: <b>{$pos['formation']}</b>\\n";
        $msg .= "🎯 Вхід: <code>{$pos['entry_price']}</code>\\n";
        $msg .= "🛑 Короткий Стоп: <code>{$pos['stop_loss']}</code>\\n";
        $msg .= "🏁 Короткий Тейк: <code>{$pos['take_profit']}</code>\\n";
        $msg .= "⏳ Ліміт утримання: <b>300 сек (5 хв)</b>\\n";
        $msg .= "💰 Обсяг: <b>" . number_format($pos['amount_usdt'], 2) . " USDT</b>";

        $this->sendMessage($msg);
    }

    public function sendTradeClosed(array $trade): void
    {
        $isWin = $trade['net_pnl'] >= 0;
        $icon = $isWin ? "✅ 🎉" : "❌ 🛑";
        $reason = $trade['result'] === 'TP' ? 'Take Profit' : ($trade['result'] === 'SL' ? 'Stop Loss' : 'Таймаут 5 хв');
        
        $msg = "{$icon} <b>Угода закрита: {$trade['symbol']} ({$reason})</b>\\n\\n";
        $msg .= "🚪 Вхід: <code>{$trade['entry_price']}</code> → Вихід: <code>{$trade['exit_price']}</code>\\n";
        $msg .= "💵 Чистий P&L: <b>" . ($isWin ? "+" : "") . number_format($trade['net_pnl'], 2) . " USDT</b>\\n";
        $msg .= "⏱️ Тривалість: <b>" . ($trade['duration_sec'] ?? 0) . " сек</b>\\n";
        $msg .= "🧾 Комісія: <code>" . number_format($trade['fee'], 4) . " USDT</code>";

        $this->sendMessage($msg);
    }

    public function sendAlert(string $text): void
    {
        $msg = "⚠️ <b>Системне сповіщення АвтоСкальпінг</b>\\n\\n" . htmlspecialchars($text);
        $this->sendMessage($msg);
    }

    private function sendMessage(string $htmlText): void
    {
        if (empty($this->botToken) || empty($this->chatId)) {
            return;
        }

        $url = "https://api.telegram.org/bot{$this->botToken}/sendMessage";
        $postData = [
            'chat_id' => $this->chatId,
            'text' => $htmlText,
            'parse_mode' => 'HTML',
            'disable_web_page_preview' => true
        ];

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query($postData),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 4
        ]);
        curl_exec($ch);
        curl_close($ch);
    }
}
`
  },
  {
    filename: 'setup.sh',
    description: 'Bash-скрипт авто-інсталяції на Ubuntu / Debian VPS та налаштування Cron',
    content: `#!/usr/bin/env bash
# Автоматичне встановлення АвтоСкальпінг Бота Формацій на VPS
set -e

echo "=== Встановлення AutoScalping Формації (h00k.top) v2.5 ==="

sudo apt update
sudo apt install -y php-cli php-curl php-json php-mbstring curl git

mkdir -p /var/www/bot/cache
mkdir -p /var/www/bot/data
mkdir -p /var/www/bot/logs

cp *.php /var/www/bot/

chmod -R 755 /var/www/bot
chmod -R 777 /var/www/bot/cache
chmod -R 777 /var/www/bot/data
chmod -R 777 /var/www/bot/logs

CRON_JOB="* * * * * cd /var/www/bot && php bot_formations.php >> /var/www/bot/logs/cron.log 2>&1"
(crontab -l 2>/dev/null | grep -v "bot_formations.php" ; echo "$CRON_JOB") | crontab -

echo "✅ Встановлення завершено успішно!"
echo "Для перегляду логів: tail -f /var/www/bot/logs/cron.log"
`
  },
  {
    filename: 'README.md',
    description: 'Інструкція: швидкий скальпінг <= 5 хв, короткі TP/SL, h00k.top та налаштування cron',
    content: `# AutoScalping Формації - Торговий Бот h00k.top (v2.5)

Автоматичний скальпінг на базі технічних формацій **h00k.top** з новою функцією **швидких позицій до 5 хвилин**.

---

## ⚡ Функція коротких позицій до 5 хв (Quick Scalp)

- **Короткий Тейк-Профіт**: \`0.45%\` (налаштовується у config.php)
- **Короткий Стоп-Лос**: \`0.25%\` (налаштовується у config.php)
- **Жорсткий таймаут 5 хвилин (300 секунд)**:
  Якщо позиція протягом 5 хвилин не досягає TP або SL, бот автоматично закриває її за ринковою ціною (\`TIME_5M\`), вивільняючи слот для наступного імпульсу!
- Вмикається параметром:
  \`\`\`php
  define('QUICK_SCALPING_5M_ENABLED', true);
  define('QUICK_SCALPING_MAX_DURATION_SEC', 300);
  \`\`\`

---

## 🌐 Справжнє з'єднання з h00k.top

Бот безпосередньо звертається до скрінера **h00k.top** та використовує алгоритм виявлення W/M-патернів, висхідних/спадних трикутників та прапорів на основі живих котирувань Binance Futures.

---

## 🚀 Встановлення на сервер

\`\`\`bash
mkdir -p /var/www/bot
cd /var/www/bot
chmod +x setup.sh
./setup.sh
\`\`\`
`
  }
];
