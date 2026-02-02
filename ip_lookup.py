import requests
import csv
import os
import time
import json

# 配置
INPUT_FILE = 'proxy.txt'
OUTPUT_FILE = 'proxy.csv'
API_URL = 'https://api.live.bilibili.com/ip_service/v1/ip_service/get_ip_addr'

def get_ip_info(ip):
    """查询单个IP信息"""
    try:
        # 添加 User-Agent 防止被简单的反爬拦截
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        response = requests.get(f"{API_URL}?ip={ip}", headers=headers, timeout=10)
        data = response.json()
        
        if data['code'] == 0:
            return data['data']
        else:
            print(f"查询失败 {ip}: {data.get('message', '未知错误')}")
            return None
    except Exception as e:
        print(f"请求异常 {ip}: {str(e)}")
        return None

def main():
    # 1. 读取 proxy.txt
    if not os.path.exists(INPUT_FILE):
        print(f"{INPUT_FILE} 不存在")
        return

    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        # 读取非空行并去除首尾空格
        ips = [line.strip() for line in f if line.strip()]

    if not ips:
        print("没有检测到 IP")
        return

    print(f"开始查询 {len(ips)} 个 IP...")
    
    results = []
    
    # 2. 遍历查询
    for ip in ips:
        info = get_ip_info(ip)
        if info:
            results.append({
                'addr': info.get('addr', ip),
                'country': info.get('country', ''),
                'province': info.get('province', ''),
                'city': info.get('city', ''),
                'isp': info.get('isp', '')
            })
        # 礼貌性延时，防止触发 API 速率限制
        time.sleep(0.5)

    # 3. 按照国家排序
    # 注意：中文排序是基于 Unicode 编码的，这通常能把相同国家的聚在一起
    results.sort(key=lambda x: x['country'])

    # 4. 写入 proxy.csv
    headers = ['addr', 'country', 'province', 'city', 'isp']
    
    # 使用 utf-8-sig 编码，确保 Excel 打开中文不乱码
    with open(OUTPUT_FILE, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        writer.writerows(results)

    print(f"处理完成，结果已保存至 {OUTPUT_FILE}")

if __name__ == '__main__':
    main()
