import requests
from bs4 import BeautifulSoup

def scrape_eskom():
    url = "https://tenderbulletin.eskom.co.za/Tenders/"
    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.get(url, headers=headers)

    if response.status_code != 200:
        print("Failed to load page:", response.status_code)
        return

soup = BeautifulSoup(response.content, "html.parser")

# Save page to file for inspection
with open("eskom_page.html", "w", encoding="utf-8") as f:
    f.write(soup.prettify())

table = soup.find("table")
if not table:
    print("Table not found. Page may have changed.")
    

    rows = table.find_all("tr")[1:]  # Skip header

    for row in rows[:5]:  # limit to first 5
        cols = row.find_all("td")
        if len(cols) < 4:
            continue

        tender_no = cols[0].text.strip()
        description = cols[1].text.strip()
        issue_date = cols[2].text.strip()
        closing_date = cols[3].text.strip()

        print(f"Tender No   : {tender_no}")
        print(f"Description : {description}")
        print(f"Issue Date  : {issue_date}")
        print(f"Closing Date: {closing_date}")
        print("-" * 40)

if __name__ == "__main__":
    scrape_eskom()
