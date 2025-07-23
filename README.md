# 🧾 Tender Tool – Public Sector Tender Discovery & Insights

Tender Tool is a serverless system that automates the discovery, categorization, and analysis of public sector tenders in South Africa. It crawls government websites to collect and organize tenders, then surfaces relevant opportunities to sales teams with optional AI-generated summaries and smart alerts.

---

## 🌍 Problem Statement

South African tenders are published across dozens of disconnected websites (e.g. eTenders, Eskom, municipal portals), each with unique formats. This makes discovering relevant opportunities slow, inefficient, and prone to being missed.

---

## 🚀 Solution

Tender Tool addresses this by:
- Automatically crawling tender portals on a schedule
- Extracting and categorizing tender information (RFQs, RFPs, RFIs)
- Sending notifications to stakeholders based on keywords or categories
- Optionally summarizing tender content using GenAI (AWS Bedrock)
- Presenting tenders through a searchable, modern web dashboard

---

## 🧩 Key Features

- 🔁 Automated Tender Crawling (via AWS Lambda + EventBridge)
- 📥 Raw Tender Storage (Amazon S3)
- 🧠 Categorization & Structuring (Lambda + DynamoDB)
- 📊 Web Dashboard for Browsing & Filtering Tenders (React + Amplify)
- 🔔 Smart Alerts via Email or SMS (SNS / SES)
- 🧾 AI-Powered Summarization (Optional - AWS Bedrock)

---

## ⚙️ Architecture Overview

Serverless-first stack on AWS:
- **Crawler**: Python + AWS Lambda
- **Scheduler**: AWS EventBridge
- **Raw Storage**: Amazon S3
- **Data Parsing**: Lambda (parser function)
- **Structured DB**: DynamoDB
- **Notifications**: SNS / SES
- **Frontend**: ReactJS (hosted on AWS Amplify or S3 + CloudFront)
- **API Layer**: API Gateway + Lambda
- **(Optional)**: AWS Bedrock for GenAI summaries

<img width="728" height="380" alt="Screenshot_2025-07-03_at_08 18 50 1" src="https://github.com/user-attachments/assets/cf931233-a1dd-447b-8504-0c79641a853b" />


---

## 🛠️ Technologies Used

| Area              | Tech Stack                  |
|-------------------|-----------------------------|
| Crawling Engine   | Python (BeautifulSoup, Requests) |
| Backend Serverless| AWS Lambda, EventBridge     |
| Storage           | Amazon S3, DynamoDB         |
| Notifications     | AWS SNS / SES               |
| AI Summarization  | AWS Bedrock (optional)      |
| Frontend          | ReactJS + AWS Amplify       |
| API               | AWS API Gateway             |

---

## 🗂️ Project Structure

