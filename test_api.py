import requests
import json
import time

# --- CONFIGURATION (Change these after deploying GAS) ---
# Once you deploy GAS as a Web App, paste the URL here.
# For local testing logic simulation, we will use a dummy URL.
GAS_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
TEST_USER_ID = "RapidAPI_User_Test_001"
HEADERS = {
    "X-RapidAPI-User": TEST_USER_ID,
    "Content-Type": "application/json"
}

def test_status():
    print("\n--- Testing GET /status ---")
    try:
        response = requests.get(GAS_URL, params={"path": "status"}, headers=HEADERS)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

def test_register_channel():
    print("\n--- Testing POST /register-channel ---")
    payload = {
        "channel_type": "discord",
        "webhook_url": "https://discord.com/api/webhooks/mock_url",
        "agent_name": "Test-Agent-Alpha"
    }
    try:
        response = requests.post(GAS_URL, params={"path": "register-channel"}, json=payload, headers=HEADERS)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

def test_report_task():
    print("\n--- Testing POST /report-task ---")
    payload = {
        "agent_id": "Agent-X",
        "status": "SUCCESS",
        "message": "Local test task completed successfully."
    }
    try:
        response = requests.post(GAS_URL, params={"path": "report-task"}, json=payload, headers=HEADERS)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

def test_heartbeat():
    print("\n--- Testing POST /heartbeat ---")
    payload = {
        "service_name": "Cloudflare-Worker-Primary",
        "status": "HEALTHY",
        "latency": 45
    }
    try:
        response = requests.post(GAS_URL, params={"path": "heartbeat"}, json=payload, headers=HEADERS)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

def test_dashboard():
    print("\n--- Testing GET /dashboard ---")
    try:
        response = requests.get(GAS_URL, params={"path": "dashboard"}, headers=HEADERS)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    print("Central Data Hub API Test Script")
    print("Note: This will likely fail until you replace GAS_URL with your actual deployment URL.")
    
    test_status()
    # test_register_channel()
    # test_report_task()
    # test_heartbeat()
    # test_dashboard()
