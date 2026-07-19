import psycopg2
import sys
import json

def main():
    conn = psycopg2.connect("postgresql://tradinguser:TradingPass2026!@localhost:5432/tradingdb")
    cur = conn.cursor()
    query = sys.argv[1] if len(sys.argv) > 1 else "SELECT id, email, plan FROM users;"
    try:
        cur.execute(query)
        if cur.description:
            colnames = [desc[0] for desc in cur.description]
            rows = cur.fetchall()
            results = [dict(zip(colnames, row)) for row in rows]
            print(json.dumps(results, indent=2, default=str))
        else:
            conn.commit()
            print(json.dumps({"status": "success"}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == '__main__':
    main()
