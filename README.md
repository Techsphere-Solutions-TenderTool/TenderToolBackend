<p align="center">
  <img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/lOgO-aws.jpg" width="220" alt="Tender Tool Logo"/>
</p>

# Tender Tool Backend API

The **Tender Tool Backend** is a **serverless API** built using **AWS Lambda**, **Node.js**, and integrated AWS services. It serves as the core engine for the **Tender Tool platform**, automating the discovery, aggregation, normalization, and analysis of public sector tenders from decentralized sources such as **Eskom**, **Transnet**, and **SANRAL**.

It securely integrates with **AWS Cognito**, **Amazon RDS (PostgreSQL)**, **Amazon S3**, **Amazon SNS**, **SQS**, and **EventBridge** to deliver real-time, personalized tender notifications and AI-powered insights.

---

## Table of Contents
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

## Introduction
The backend provides the **cloud logic and data pipeline** for the **Tender Tool** platform. It is responsible for:

- **Automated scraping** of public tenders from multiple government sources  
- **Normalization & categorization** using intelligent parsing  
- **Structured storage** in PostgreSQL via AWS RDS  
- **Personalized notifications** via Amazon SNS  
- **AI-generated summaries** and **chatbot support**  
- **Secure user authentication** with AWS Cognito  

---

## Purpose
To create a **unified, transparent, and intelligent tender discovery system** that:

- Centralizes fragmented public procurement data  
- Reduces manual search effort for suppliers  
- Enables data-driven bidding strategies  
- Promotes fair competition and accountability in public spending  

---

## System Overview
The system follows a **fully serverless, event-driven microservices architecture** on **AWS**:

```mermaid

graph TD
    A[EventBridge Scheduler] --> B[Scraper Lambdas]
    B --> C[S3 Raw JSON Storage]
    C --> D[SQS Queue]
    D --> E[Normalizer Lambda]
    E --> F[RDS PostgreSQL]
    E --> G[SNS Notifications]
    H[API Gateway] --> I[Tender API Handler]
    I --> F
    J[React Frontend] --> H
    K[Cognito] --> H
The frontend (React + Tailwind) communicates via API Gateway, while Lambda functions handle scraping, processing, storage, and notifications.
________________________________________
AWS Console Screenshots
<img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/AWS/Console1.jpg" alt="AWS Console - Lambda Functions" width="48%">
 <img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/AWS/Console2.jpg" alt="AWS Console - RDS PostgreSQL" width="48%"> 
<img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/AWS/Console3.jpg" alt="AWS Console - S3 Buckets" width="48%">
<img src="https://raw.githubusercontent.com/Techsphere-Solutions-TenderTool/TenderToolBackend/main/Images/AWS/Console4.jpg" alt="AWS Console - SNS &#x26; EventBridge" width="48%"> 
________________________________________
Prerequisites
Before you begin, ensure you have:
•	Node.js (v20+ LTS)
•	npm
•	AWS CLI & AWS SAM CLI
•	Visual Studio Code
•	An AWS account with IAM permissions
•	SonarCloud account (optional for code quality)
________________________________________
Installation Guide
1.	Clone the repository 
bash
git clone https://github.com/Techsphere-Solutions-TenderTool/TenderToolBackend.git
cd TenderToolBackend
2.	Install dependencies 
bash
npm install
3.	Copy environment file 
bash
cp .env.example .env
Then update .env with your AWS and database credentials.
4.	Run locally 
bash
npm run dev
5.	Test endpoint 
bash
curl http://localhost:3000/api/health
________________________________________
Environment Configuration
env
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
Security Note: Never commit .env to Git. Use AWS Secrets Manager in production.
________________________________________
Available Scripts
Script	Description
npm start	Run in production mode
npm run dev	Run with hot-reload (nodemon)
npm test	Run Jest unit tests
npm run coverage	Generate test coverage report
npm run lint	Lint code with ESLint
sam build	Build SAM application
sam deploy	Deploy to AWS
________________________________________
API Endpoints
Base URL: https://api.tendertool.tech/api
Endpoint	Method	Description
/tenders	GET	List all tenders
/tenders/:id	GET	Get tender by ID
/tenders/search	POST	Search by keyword, category, location
/preferences	POST	Save user preferences
/notifications/subscribe	POST	Subscribe to alerts
/chatbot/query	POST	AI chatbot query
/summaries/:id	GET	Get AI-generated tender summary
Example Request
bash
GET /api/tenders
Authorization: Bearer <cognito-jwt-token>
Example Response
json
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
________________________________________
Security
•	Authentication: AWS Cognito User Pools + JWT
•	Authorization: Role-based access via Cognito groups
•	Encryption: 
o	In transit: TLS 1.2+
o	At rest: AWS KMS + RDS encryption
•	Secrets: AWS Secrets Manager / Parameter Store
•	Compliance: POPIA-aligned data handling
•	Scanning: SonarCloud + GitHub Dependency Scan
________________________________________
Deployment (AWS SAM)
bash
sam build
sam deploy --guided
•	Uses OIDC with GitHub Actions
•	Deploys Lambda, API Gateway, RDS, S3, SNS, SQS, EventBridge
•	Auto-scaling and pay-per-use
________________________________________
Continuous Integration (GitHub Actions)
yaml
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
•	Test → Build → SonarCloud → Deploy
•	Push to main → Auto-deploy
________________________________________
Tech Stack
Layer	Technology
Runtime	Node.js v20
Framework	AWS Lambda + Express (local)
Database	Amazon RDS (PostgreSQL)
Storage	Amazon S3
Auth	AWS Cognito
Messaging	Amazon SQS, SNS
Scheduler	Amazon EventBridge
API	Amazon API Gateway
Frontend	React + Vite + Tailwind + DaisyUI
Deployment	AWS SAM
CI/CD	GitHub Actions
Code Quality	SonarCloud
Testing	Jest + Supertest
________________________________________
Repository Links
•	Frontend: TenderToolFrontend
•	Backend: TenderToolBackend
________________________________________

References
•	AWS Documentation. (2025). AWS Lambda, RDS, S3, SNS, EventBridge.
•	Atlassian. (n.d.). Definition of Ready (DoR).
•	ICAgile. (2023). Definition of Done.
•	POPIA Compliance Guidelines. (2021). South Africa.
•	GitHub Actions Documentation. (2024).
________________________________________
Techsphere Solutions © 2025
Keenan Ghisyan | Aisha Bilal Jakhura | Khatija Moosa Amod | Muhammed Ameer Amed | Shreya Naidoo | Varun Perumal

