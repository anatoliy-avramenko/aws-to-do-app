import { DynamoDBStreamEvent, DynamoDBRecord } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { todoItem } from "../types";


interface streamRecord {
  newItem: todoItem | undefined;
  oldItem: todoItem | undefined;
}

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "";
const ebClient = new EventBridgeClient({});

const sendEvent = async (eventType: string, data: Record<string, any>) => {
  console.log(`Sending event: ${eventType}`);
  const res = await ebClient.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: "TodoService",
          EventBusName: EVENT_BUS_NAME,
          Detail: JSON.stringify(data),
          DetailType: eventType,
        },
      ],
    })
  );
  console.log(`Event sent: ${eventType}`);
};

const parseRecord = (record: DynamoDBRecord): streamRecord => {
  let newItem;
  let oldItem;

  if (record.dynamodb?.NewImage) {
    newItem = unmarshall(
      record.dynamodb?.NewImage as { [key: string]: AttributeValue }
    ) as todoItem;
  }

  if (record.dynamodb?.OldImage) {
    oldItem = unmarshall(
      record.dynamodb?.OldImage as { [key: string]: AttributeValue }
    ) as todoItem;
  }

  return { newItem, oldItem };
};

export const handler = async function (
  event: DynamoDBStreamEvent
): Promise<void> {
  for await (const record of event.Records) {
    const todoRecord = parseRecord(record);

    switch (record.eventName) {
      case "INSERT": {
        console.log("Item Created: ", todoRecord.newItem);
        if (todoRecord.newItem) {
          await sendEvent("TodoCreated", todoRecord.newItem);
        }
        break;
      }
      case "MODIFY": {
        console.log("Item Modified: ", todoRecord.oldItem, todoRecord.newItem);
        if (
          todoRecord.newItem &&
          todoRecord.oldItem &&
          !todoRecord.oldItem.completed &&
          todoRecord.newItem.completed
        ) {
          await sendEvent("TodoCompleted", todoRecord.newItem);
        }
        break;
      }
      case "REMOVE": {
        console.log("Item Deleted: ", todoRecord.oldItem);
        if (todoRecord.oldItem) {
          await sendEvent("TodoDeleted", todoRecord.oldItem);
        }
        break;
      }
    }
  }
};

