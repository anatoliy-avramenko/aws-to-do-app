import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { LambdaIntegration, RestApi } from "aws-cdk-lib/aws-apigateway";
import { AttributeType, BillingMode, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { DynamoEventSource, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";

export class TodoAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 Bucket
    const bucket = new Bucket(this, 'TodoImportBucket');

    // Import Queue
    const queue = new Queue(this, 'TodoImportQueue', {
      visibilityTimeout: cdk.Duration.seconds(120),
    });

    // SNS Topic
    const topic = new Topic(this, "TodoEventTopic");
    topic.addSubscription(new EmailSubscription("anatolii.avramenko@1337.tech"));

    // EventBridge bus
    const bus = new EventBus(this, "TodoEventBus");

    // DynamoDB Table
    const table = new Table(this, "TodoTable", {
      partitionKey: {
        name: "todoId",
        type: AttributeType.STRING,
      },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_AND_OLD_IMAGES, // add this line
      pointInTimeRecovery: true,
    });

    const commonFunctionProps: NodejsFunctionProps = {
      handler: 'handler',
      runtime: Runtime.NODEJS_16_X,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(60),
      bundling: {
        minify: true,
      },
    };

    const apiFunctionProps: NodejsFunctionProps = {
      timeout: cdk.Duration.seconds(29),
      environment: {
        TABLE_NAME: table.tableName,
      }
    };

    // Lambda Functions
    const getSingleFunction = new NodejsFunction(this, "GetSingleTodoFunction", {
      entry: 'functions/get_single_todo/handler.ts',
      ...commonFunctionProps,
      ...apiFunctionProps,
    });
    const getAllFunction = new NodejsFunction(this, "GetAllTodoFunction", {
      entry: 'functions/get_all_todo/handler.ts',
      ...commonFunctionProps,
      ...apiFunctionProps,
    });
    const postFunction = new NodejsFunction(this, "PostTodoFunction", {
      entry: 'functions/post_todo/handler.ts',
      ...commonFunctionProps,
      ...apiFunctionProps,
    });
    const patchFunction = new NodejsFunction(this, "PatchTodoFunction", {
      entry: 'functions/patch_todo/handler.ts',
      ...commonFunctionProps,
      ...apiFunctionProps,
    });
    const deleteFunction = new NodejsFunction(this, "DeleteTodoFunction", {
      entry: 'functions/delete_todo/handler.ts',
      ...commonFunctionProps,
      ...apiFunctionProps,
    });

    const streamFunction = new NodejsFunction(this, "StreamFunction", {
      entry: "functions/stream/handler.ts",
      ...commonFunctionProps,
      environment: {
        EVENT_BUS_NAME: bus.eventBusName,
      },
    });

    const todoCreatedFunction = new NodejsFunction(this, "TodoCreatedFunction", {
      entry: "functions/todoCreatedEvent/handler.ts",
      ...commonFunctionProps,
    });
    const todoCompletedFunction = new NodejsFunction(this, "TodoCompletedFunction", {
        entry: "functions/todoCompletedEvent/handler.ts",
        ...commonFunctionProps,
        environment: {
          TOPIC_ARN: topic.topicArn,
        },
      }
    );
    const todoDeletedFunction = new NodejsFunction(this, "TodoDeletedFunction", {
      entry: "functions/todoDeletedEvent/handler.ts",
      ...commonFunctionProps,
    });

    const s3ToSqsFunction = new NodejsFunction(this, "S3ToSqsFunction", {
      entry: "functions/s3ToSqs/handler.ts",
      ...commonFunctionProps,
      timeout: cdk.Duration.seconds(900),
      environment: {
        QUEUE_URL: queue.queueUrl,
      },
    });

    const sqsToDynamo = new NodejsFunction(this, "SqsToDynamoFunction", {
      entry: "functions/sqsToDynamo/handler.ts",
      ...commonFunctionProps,
      timeout: cdk.Duration.seconds(60),
      environment: {
        TABLE_NAME: table.tableName,
      },
    });


    // Outputs
    new cdk.CfnOutput(this, 'TodoImportBucketOutput', {
      value: bucket.bucketName,
    });

    // DynamoDB stream integration
    streamFunction.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        retryAttempts: 3,
      })
    );

    // SQS integration
    sqsToDynamo.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 5,
      })
    );

    // S3 integration
    bucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(s3ToSqsFunction),
      { prefix: "import/" }
    );

    // Add Lambda runtime permissions
    table.grantReadData(getSingleFunction);
    bus.grantPutEventsTo(streamFunction);
    table.grantReadData(getAllFunction);
    table.grantReadData(getAllFunction);
    table.grantWriteData(postFunction);
    table.grantWriteData(patchFunction);
    table.grantWriteData(deleteFunction);
    topic.grantPublish(todoCompletedFunction);
    bucket.grantRead(s3ToSqsFunction);
    queue.grantSendMessages(s3ToSqsFunction);
    table.grantWriteData(sqsToDynamo);


    // REST API
    const restApi = new RestApi(this, "RestApi", {});
    const todos = restApi.root.addResource("todo");
    const todo = todos.addResource("{todoId}");
    todos.addMethod("GET", new LambdaIntegration(getAllFunction));
    todos.addMethod("POST", new LambdaIntegration(postFunction));
    todo.addMethod("GET", new LambdaIntegration(getSingleFunction));
    todo.addMethod("PATCH", new LambdaIntegration(patchFunction));
    todo.addMethod("DELETE", new LambdaIntegration(deleteFunction));

    // EventBridge integrations
    new Rule(this, "TodoCreatedRule", {
      eventBus: bus,
      eventPattern: { detailType: ["TodoCreated"] },
      targets: [new LambdaFunction(todoCreatedFunction)],
    });

    new Rule(this, "TodoCompletedRule", {
      eventBus: bus,
      eventPattern: { detailType: ["TodoCompleted"] },
      targets: [new LambdaFunction(todoCompletedFunction)],
    });

    new Rule(this, "TodoDeletedRule", {
      eventBus: bus,
      eventPattern: { detailType: ["TodoDeleted"] },
      targets: [new LambdaFunction(todoDeletedFunction)],
    });
  }

}
