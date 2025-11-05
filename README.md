<p align="center">
  <img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/lOgO-aws.jpg" width="220" alt="Tender Tool Logo"/>
</p>

# Tender Tool Backend API

The **Tender Tool Backend** is a **serverless API** built using **AWS Lambda**, **Node.js**, and integrated AWS services. It serves as the core engine for the **Tender Tool platform**, automating the discovery, aggregation, normalization, and analysis of public sector tenders from decentralized sources such as **Eskom**, **Transnet**, and **SANRAL**.

It securely integrates with **AWS Cognito**, **Amazon RDS (PostgreSQL)**, **Amazon S3**, **Amazon SNS**, **SQS**, and **EventBridge** to deliver real-time, personalized tender notifications and AI-powered insights.

---

## ✨ Table of Contents

1. [Introduction](#introduction)
2. [Purpose](#purpose)
3. [System Overview](#system-overview)
4. [AWS Console Screenshots](#aws-console-screenshots)
5. [Prerequisites](#prerequisites)
6. [Installation Guide](#installation-guide)
7. [Environment Configuration](#environment-configuration)
8. [Available Scripts](#available-scripts)
9. [API Endpoints](#api-endpoints)
10. [Security](#security)
11. [Deployment (AWS SAM)](#deployment-aws-sam)
12. [Continuous Integration (GitHub Actions)](#continuous-integration-github-actions)
13. [Tech Stack](#tech-stack)
14. [Repository Links](#repository-links)
15. [References](#references)

---

## 🌍 Introduction

The backend provides the **cloud logic and data pipeline** for the **Tender Tool** platform. It is responsible for:

* ✨ **Automated scraping** of public tenders from multiple government sources
* ⚙️ **Normalization & categorization** using intelligent parsing
* 📊 **Structured storage** in PostgreSQL via AWS RDS
* 📢 **Personalized notifications** via Amazon SNS
* 🤖 **AI-generated summaries** and **chatbot support**
* 🔐 **Secure user authentication** with AWS Cognito

---

## 💡 Purpose

To create a **unified, transparent, and intelligent tender discovery system** that:

* Centralizes fragmented public procurement data
* Reduces manual search effort for suppliers
* Enables data-driven bidding strategies
* Promotes fair competition and accountability in public spending

---

## 📊 System Overview

The system follows a **fully serverless, event-driven microservices architecture** on **AWS**.

![System Architecture](https://github.com/Techsphere-Solutions-TenderTool/TenderToolBackend/blob/main/Images/WIL-ArchitectureDiagram.jpg)

---

## 📃 AWS Console Screenshots

<img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/AWS/Console1.jpg" width="48%"/>
<img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/AWS/Console2.jpg" width="48%"/>
<img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/AWS/Console3.jpg" width="48%"/>
<img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/AWS/Console4.jpg" width="48%"/>

---

## 🚀 Prerequisites

* Node.js (v20+ LTS)
* npm
* AWS CLI & AWS SAM CLI
* Visual Studio Code
* AWS account with IAM permissions
* SonarCloud account (optional)

---

## 📚 Installation Guide

```bash
git clone https://github.com/Techsphere-Solutions-TenderTool/TenderToolBackend.git
cd TenderToolBackend
npm install
cp .env.example .env
# Update .env with credentials
npm run dev
curl http://localhost:3000/api/health
```

---

## 🔢 Environment Configuration

Create a `.env` file:

```
AWS_REGION=za-north-1
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
DB_HOST=your-rds-endpoint.amazonaws.com
DB_USER=admin
DB_PASSWORD=your-secure-password
DB_NAME=tenderdb
COGNITO_USER_POOL_ID=za-north-1_XXXXXXXXX
SNS_TOPIC_ARN=arn:aws:sns:za-north-1:xxxx:NewTenderTopic
S3_BUCKET=tender-raw-data-bucket
PORT=3000
```

> **Note:** Use AWS Secrets Manager for production secrets.

---

## 📅 Available Scripts

| Script             | Description         |
| ------------------ | ------------------- |
| `npm start`        | Run in production   |
| `npm run dev`      | Run with hot-reload |
| `npm test`         | Run Jest unit tests |
| `npm run coverage` | Coverage report     |
| `npm run lint`     | ESLint check        |
| `sam build`        | SAM build           |
| `sam deploy`       | Deploy to AWS       |

---

## 🚧 API Endpoints

**Base URL:** `https://api.tendertool.tech/api`

| Endpoint                   | Method | Description          |
| -------------------------- | ------ | -------------------- |
| `/tenders`                 | GET    | List all tenders     |
| `/tenders/:id`             | GET    | Get tender by ID     |
| `/tenders/search`          | POST   | Search by filters    |
| `/preferences`             | POST   | Save user prefs      |
| `/notifications/subscribe` | POST   | Tender alerts        |
| `/chatbot/query`           | POST   | Chatbot Q&A          |
| `/summaries/:id`           | GET    | AI-generated summary |

**Example:**

```bash
curl -H "Authorization: Bearer <JWT>" https://api.tendertool.tech/api/tenders
```

```json
{
  "tenders": [
    {
      "id": "T2025-001",
      "title": "Road Maintenance - N1",
      "source": "SANRAL",
      "category": "Construction",
      "closingDate": "2025-12-15",
      "value": "R 45,000,000"
    }
  ]
}
```

---

## 🔒 Security

* **Auth:** AWS Cognito User Pools + JWT
* **Roles:** Cognito groups (RBAC)
* **Encryption:** TLS 1.2+ (in transit), AWS KMS (at rest)
* **Secrets:** AWS Secrets Manager
* **Compliance:** POPIA ready
* **Auditing:** GitHub Dependabot + SonarCloud

---

## 🚜 Deployment (AWS SAM)

```bash
sam build
sam deploy --guided
```

* Auto-deploys all services
* Supports OIDC GitHub Actions
* Scales on-demand

---

## 🚧 Continuous Integration (GitHub Actions)

![DevOps Diagram](https://github.com/Techsphere-Solutions-TenderTool/TenderToolBackend/blob/main/Images/DevOpsPipelinesFlowChart%20\(1\)%20\(1\).jpg)

```yaml
name: CI/CD Pipeline
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test -- --coverage
      - run: npm run lint
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    uses: ./.github/workflows/deploy.yml
```

* **Test ✅ Build ✅ Sonar ✅ Deploy**

---

## 💡 Tech Stack

| Layer           | Technology              |
| --------------- | ----------------------- |
| Runtime         | Node.js 20              |
| API             | AWS Lambda + Express    |
| Auth            | AWS Cognito             |
| DB              | Amazon RDS (PostgreSQL) |
| Storage         | Amazon S3               |
| Queue/Messaging | Amazon SNS + SQS        |
| Schedule        | Amazon EventBridge      |
| Deployment      | AWS SAM                 |
| CI/CD           | GitHub Actions          |
| Quality         | SonarCloud              |
| Testing         | Jest + Supertest        |

---

## 🔗 Repository Links

* **Frontend:** [TenderToolFrontend](https://github.com/Techsphere-Solutions-TenderTool/Frontend)
* **Backend:** [TenderToolBackend](https://github.com/Techsphere-Solutions-TenderTool/TenderToolBackend)

---

## 📖 References

* AWS Docs: Lambda, S3, RDS, SNS, Cognito
* POPIA Guidelines (2021)
* GitHub Actions Docs (2024)
* ICAgile & Atlassian (DoR & DoD)

##  Liscensing 
please see our MIT Liscense in the Repository 
---

<p align="center">
  <strong>Techsphere Solutions © 2025</strong><br/>
  Keenan Ghisyan • Aisha Bilal Jakhura • Khatija Moosa Amod • Muhammed Ameer Amed • Shreya Naidoo • Varun Perumal
</p>
