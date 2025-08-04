import requests

def fetch_tenders(page=1, page_size=50, date_from="2024-01-01", date_to="2024-03-31"):
    url = "https://ocds-api.etenders.gov.za/api/OCDSReleases"
    params = {
        "PageNumber": page,
        "PageSize": page_size,
        "dateFrom": date_from,
        "dateTo": date_to
    }

    headers = {
        "Accept": "application/json"
    }

    response = requests.get(url, params=params, headers=headers)

    if response.status_code != 200:
        print(f"Error: {response.status_code}")
        return

    data = response.json()

    # Print summary of tenders
    for release in data.get("releases", []):
        tender = release.get("tender", {})
        title = tender.get("title", "No Title")
        description = tender.get("description", "No Description")
        closing_date = tender.get("tenderPeriod", {}).get("endDate", "No closing date")
        doc_url = tender.get("documents", [{}])[0].get("url", "No document")

        print(f"📌 Title       : {title}")
        print(f"📝 Description : {description}")
        print(f"📅 Closing     : {closing_date}")
        print(f"📄 Document    : {doc_url}")
        print("-" * 60)

if __name__ == "__main__":
    fetch_tenders()
