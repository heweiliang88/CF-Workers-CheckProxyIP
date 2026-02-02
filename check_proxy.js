const fs = require('fs');
const dns = require('dns').promises;
const tls = require('tls');
const https = require('https');
const http = require('http');
const path = require('path');

// 配置
const INPUT_FILE = 'domain.txt';
const OUTPUT_FILE = 'result.txt';
const PROXY_FILE = 'proxy.txt'; // 1. 定义新的输出文件
const CONCURRENCY = 20; 
const TIMEOUT = 3000; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getIpInfo(ip) {
    return new Promise((resolve) => {
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

async function checkIp(ip, port = 443) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let isResolved = false;

        const socket = tls.connect({
            host: ip,
            port: port,
            servername: 'speed.cloudflare.com', 
            timeout: TIMEOUT,
            rejectUnauthorized: false 
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

async function resolveDomain(domain) {
    try {
        let target = domain;
        let port = 443;
        if (domain.includes(':')) {
            const parts = domain.split(':');
            target = parts[0];
            port = parseInt(parts[1]) || 443;
        }
        const ips = await dns.resolve4(target).catch(() => []);
        return ips.map(ip => ({ ip, port, originalDomain: domain }));
    } catch (e) {
        console.error(`解析失败 ${domain}: ${e.message}`);
        return [];
    }
}

async function main() {
    console.log('开始处理...');
    
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

    console.log(`正在解析 ${domains.length} 个域名...`);
    let targets = [];
    for (const domain of domains) {
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain)) {
            targets.push({ ip: domain, port: 443, originalDomain: domain });
        } else {
            const results = await resolveDomain(domain);
            targets.push(...results);
        }
    }

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

    const results = [];
    
    for (let i = 0; i < uniqueTargets.length; i += CONCURRENCY) {
        const chunk = uniqueTargets.slice(i, i + CONCURRENCY);
        const promises = chunk.map(async (target) => {
            const checkResult = await checkIp(target.ip, target.port);
            
            if (checkResult.success) {
                await sleep(Math.random() * 2000); 
                const country = await getIpInfo(target.ip);
                
                const line = `${target.ip}#${country} ${checkResult.latency}ms`;
                console.log(`[成功] ${line}`);
                
                // 2. 关键修改：返回一个对象，而不是单纯的字符串
                // 这样后续想取完整行就取 line，想取纯IP就取 ip
                return {
                    line: line,          // 完整格式：1.1.1.1#CN 100ms
                    ip: target.ip,       // 纯IP格式：1.1.1.1
                    latency: checkResult.latency // 用于排序
                };
            } else {
                return null;
            }
        });

        const chunkResults = await Promise.all(promises);
        results.push(...chunkResults.filter(r => r !== null));
    }

    // 根据延迟排序
    results.sort((a, b) => a.latency - b.latency);

    // 3. 写入文件时的修改
    try {
        // 写入 result.txt：使用 map 提取 r.line
        fs.writeFileSync(path.join(__dirname, OUTPUT_FILE), results.map(r => r.line).join('\n'));
        
        // 写入 proxy.txt：使用 map 提取 r.ip (这样就只包含 IP 了)
        fs.writeFileSync(path.join(__dirname, PROXY_FILE), results.map(r => r.ip).join('\n'));
        
        console.log(`\n检测完成，结果已保存至 ${OUTPUT_FILE}`);
        console.log(`纯 IP 列表已保存至 ${PROXY_FILE}`);
        console.log(`共保留有效 IP: ${results.length} 个`);
    } catch (e) {
        console.error(`写入文件失败: ${e.message}`);
    }
}

main();
