const fs = require('fs');
const dns = require('dns').promises;
const tls = require('tls');
const https = require('https');
const http = require('http'); // Added http
const path = require('path');

// 配置
const INPUT_FILE = 'domain.txt';
const OUTPUT_FILE = 'result.txt';
const PROXY_FILE = 'proxy.txt'; // New output file
const CONCURRENCY = 20; // 并发数
const TIMEOUT = 3000; // 超时时间 ms

// 延迟函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 获取 IP 信息 (使用 ip-api.com)
async function getIpInfo(ip) {
    return new Promise((resolve) => {
        // Use http instead of https for free tier of ip-api.com
        const req = http.get(`http://ip-api.com/json/${ip}?lang=zh-CN`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.status === 'success' ? json.country : '未知');
                } catch (e) {
                    resolve('未知');
                }
            });
        });
        req.on('error', () => resolve('未知'));
        req.end();
    });
}

// 检测 IP 是否可用 (模拟连接 Cloudflare)
async function checkIp(ip, port = 443) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let isResolved = false;

        const socket = tls.connect({
            host: ip,
            port: port,
            servername: 'speed.cloudflare.com', // 关键：测试是否支持 CF 的 SNI
            timeout: TIMEOUT,
            rejectUnauthorized: false // 允许自签名或其他证书，主要测连通性
        }, () => {
            if (isResolved) return;
            isResolved = true;
            const latency = Date.now() - startTime;
            socket.end();
            resolve({ success: true, latency });
        });

        socket.on('error', (err) => {
            if (isResolved) return;
            isResolved = true;
            socket.destroy();
            resolve({ success: false, error: err.message });
        });

        socket.on('timeout', () => {
            if (isResolved) return;
            isResolved = true;
            socket.destroy();
            resolve({ success: false, error: 'Timeout' });
        });
    });
}

// 解析域名获取所有 IP
async function resolveDomain(domain) {
    try {
        // 简单处理端口，如果 domain.txt 里写了 domain:443
        let target = domain;
        let port = 443;
        if (domain.includes(':')) {
            const parts = domain.split(':');
            target = parts[0];
            port = parseInt(parts[1]) || 443;
        }

        // 解析 A 记录 (IPv4)
        const ips = await dns.resolve4(target).catch(() => []);
        return ips.map(ip => ({ ip, port, originalDomain: domain }));
    } catch (e) {
        console.error(`解析失败 ${domain}: ${e.message}`);
        return [];
    }
}

async function main() {
    console.log('开始处理...');
    
    // 1. 读取文件
    let domains = [];
    try {
        const content = fs.readFileSync(path.join(__dirname, INPUT_FILE), 'utf-8');
        domains = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    } catch (e) {
        console.error(`无法读取 ${INPUT_FILE}: ${e.message}`);
        return;
    }

    if (domains.length === 0) {
        console.log('没有待检测的域名');
        return;
    }

    // 2. 解析域名得到 IP 列表
    console.log(`正在解析 ${domains.length} 个域名...`);
    let targets = [];
    for (const domain of domains) {
        // 如果输入本身就是 IP
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain)) {
            targets.push({ ip: domain, port: 443, originalDomain: domain });
        } else {
            const results = await resolveDomain(domain);
            targets.push(...results);
        }
    }

    // 去重
    const uniqueTargets = [];
    const seen = new Set();
    targets.forEach(t => {
        const key = `${t.ip}:${t.port}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueTargets.push(t);
        }
    });

    console.log(`共获取 ${uniqueTargets.length} 个唯一 IP，开始检测延迟和地理位置...`);

    // 3. 并发检测
    const results = [];
    
    // 简单的并发控制
    for (let i = 0; i < uniqueTargets.length; i += CONCURRENCY) {
        const chunk = uniqueTargets.slice(i, i + CONCURRENCY);
        const promises = chunk.map(async (target) => {
            // 先检测连通性
            const checkResult = await checkIp(target.ip, target.port);
            
            if (checkResult.success) {
                // 如果连通，再查地理位置 (避免浪费 API 调用)
                // 注意：ip-api.com 免费版有 45次/分 的限制，这里加一点随机延迟
                await sleep(Math.random() * 2000); // Increased delay slightly to be safe
                const country = await getIpInfo(target.ip);
                
                // 格式：ip#国家 延迟
                const line = `${target.ip}#${country} ${checkResult.latency}ms`;
                console.log(`[成功] ${line}`);
                
                // Return object for sorting
                return {
                    line: line,
                    ip: target.ip,
                    latency: checkResult.latency
                };
            } else {
                // console.log(`[失败] ${target.ip}: ${checkResult.error}`);
                return null;
            }
        });

        const chunkResults = await Promise.all(promises);
        results.push(...chunkResults.filter(r => r !== null));
    }

    // Sort results by latency (ascending)
    results.sort((a, b) => a.latency - b.latency);

    // 4. 写入结果
    try {
        fs.writeFileSync(path.join(__dirname, OUTPUT_FILE), results.map(r => r.line).join('\n'));
        fs.writeFileSync(path.join(__dirname, PROXY_FILE), results.map(r => r.ip).join('\n'));
        console.log(`\n检测完成，结果已保存至 ${OUTPUT_FILE}`);
        console.log(`纯 IP 列表已保存至 ${PROXY_FILE}`);
        console.log(`共保留有效 IP: ${results.length} 个`);
    } catch (e) {
        console.error(`写入文件失败: ${e.message}`);
    }
}

main();